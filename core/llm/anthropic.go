package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
)

// anthropicVersion is the required API version header value for the Messages API.
const anthropicVersion = "2023-06-01"

// defaultAnthropicMaxTokens is the per-response output cap when the caller doesn't set one.
const defaultAnthropicMaxTokens = 4096

// AnthropicProvider speaks the Anthropic Messages API (PLAN §6.8). Its wire format differs
// from OpenAI's — tools carry an input_schema, the model emits tool_use content blocks and
// receives tool_result blocks in a user turn — so it needs its own encoder. Implemented
// over raw net/http (not anthropic-sdk-go) to keep the streaming glued to our event channel
// and the wasm/gomobile binaries small.
//
// Extended/adaptive thinking is deliberately left off: with thinking enabled the API
// requires the assistant's thinking blocks to be replayed verbatim on the tool-result
// round-trip, which this loop does not yet capture. Enabling it is a later enhancement.
type AnthropicProvider struct {
	BaseURL   string // defaults to https://api.anthropic.com when empty
	APIKey    string
	MaxTokens int
	HTTP      *http.Client
}

func (p *AnthropicProvider) Name() string { return "anthropic" }

func (p *AnthropicProvider) baseURL() string {
	if p.BaseURL == "" {
		return "https://api.anthropic.com"
	}
	return strings.TrimRight(p.BaseURL, "/")
}

// Chat runs one round against /v1/messages with streaming enabled.
func (p *AnthropicProvider) Chat(ctx context.Context, req ChatRequest, onDelta DeltaFunc) (*ChatResponse, error) {
	maxTokens := p.MaxTokens
	if maxTokens <= 0 {
		maxTokens = defaultAnthropicMaxTokens
	}
	body := map[string]any{
		"model":      req.Model,
		"max_tokens": maxTokens,
		"messages":   encodeAnthropicMessages(req.Messages),
		"stream":     true,
	}
	if req.System != "" {
		body["system"] = req.System
	}
	if len(req.Tools) > 0 {
		body["tools"] = encodeAnthropicTools(req.Tools)
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL()+"/v1/messages", bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	httpReq.Header.Set("anthropic-version", anthropicVersion)
	// On the web build the request goes out through the browser's fetch(); Anthropic only
	// returns CORS headers (allowing a direct browser call) when this opt-in is present.
	// The key already lives on-device by design, so direct browser access is acceptable here.
	// The header is harmless on native (desktop/mobile) builds, which don't hit CORS.
	httpReq.Header.Set("anthropic-dangerous-direct-browser-access", "true")
	if p.APIKey != "" {
		httpReq.Header.Set("x-api-key", p.APIKey)
	}
	resp, err := p.httpClient().Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, apiError(p.Name(), resp)
	}
	return decodeAnthropicSSE(resp.Body, onDelta)
}

// encodeAnthropicMessages maps the neutral transcript to Anthropic's content-block form:
// assistant turns carry text and tool_use blocks; a tool turn becomes a user message whose
// content is tool_result blocks.
func encodeAnthropicMessages(messages []Message) []map[string]any {
	out := make([]map[string]any, 0, len(messages))
	for _, m := range messages {
		switch m.Role {
		case RoleTool:
			content := make([]map[string]any, 0, len(m.ToolResults))
			for _, tr := range m.ToolResults {
				block := map[string]any{
					"type":        "tool_result",
					"tool_use_id": tr.CallID,
					"content":     tr.Content,
				}
				if tr.IsError {
					block["is_error"] = true
				}
				content = append(content, block)
			}
			out = append(out, map[string]any{"role": "user", "content": content})
		case RoleAssistant:
			content := []map[string]any{}
			if m.Text != "" {
				content = append(content, map[string]any{"type": "text", "text": m.Text})
			}
			for _, tc := range m.ToolCalls {
				content = append(content, map[string]any{
					"type":  "tool_use",
					"id":    tc.ID,
					"name":  tc.Name,
					"input": json.RawMessage(tc.Args),
				})
			}
			out = append(out, map[string]any{"role": "assistant", "content": content})
		default:
			out = append(out, map[string]any{
				"role":    "user",
				"content": []map[string]any{{"type": "text", "text": m.Text}},
			})
		}
	}
	return out
}

func encodeAnthropicTools(tools []ToolSpec) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, t := range tools {
		out = append(out, map[string]any{
			"name":         t.Name,
			"description":  t.Description,
			"input_schema": json.RawMessage(t.Schema),
		})
	}
	return out
}

// decodeAnthropicSSE consumes the Messages SSE stream. Text arrives as text_delta events;
// a tool call is a tool_use content block whose id/name come on content_block_start and
// whose arguments stream as input_json_delta fragments stitched back into JSON. thinking
// blocks (if ever enabled) are ignored. The stop reason is read from message_delta.
func decodeAnthropicSSE(r io.Reader, onDelta DeltaFunc) (*ChatResponse, error) {
	type block struct {
		kind     string // "text" | "tool_use"
		id, name string
		args     strings.Builder
	}
	blocks := map[int]*block{}
	var text strings.Builder
	stop := ""

	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if !strings.HasPrefix(line, "data:") {
			continue // skip "event:" lines and blanks; the JSON carries its own "type"
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		var ev struct {
			Type         string `json:"type"`
			Index        int    `json:"index"`
			ContentBlock struct {
				Type string `json:"type"`
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"content_block"`
			Delta struct {
				Type        string `json:"type"`
				Text        string `json:"text"`
				PartialJSON string `json:"partial_json"`
				StopReason  string `json:"stop_reason"`
			} `json:"delta"`
		}
		if err := json.Unmarshal([]byte(data), &ev); err != nil {
			return nil, fmt.Errorf("anthropic: decode stream event: %w", err)
		}
		switch ev.Type {
		case "content_block_start":
			b := &block{kind: ev.ContentBlock.Type, id: ev.ContentBlock.ID, name: ev.ContentBlock.Name}
			blocks[ev.Index] = b
		case "content_block_delta":
			b := blocks[ev.Index]
			switch ev.Delta.Type {
			case "text_delta":
				text.WriteString(ev.Delta.Text)
				if onDelta != nil {
					onDelta(ev.Delta.Text)
				}
			case "input_json_delta":
				if b != nil {
					b.args.WriteString(ev.Delta.PartialJSON)
				}
			}
		case "message_delta":
			if ev.Delta.StopReason != "" {
				stop = ev.Delta.StopReason
			}
		case "message_stop":
			// terminal; loop will end at EOF
		}
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("anthropic: read stream: %w", err)
	}

	msg := Message{Role: RoleAssistant, Text: text.String()}
	indexes := make([]int, 0, len(blocks))
	for idx := range blocks {
		indexes = append(indexes, idx)
	}
	sort.Ints(indexes)
	for _, idx := range indexes {
		b := blocks[idx]
		if b.kind != "tool_use" {
			continue
		}
		args := b.args.String()
		if args == "" {
			args = "{}"
		}
		msg.ToolCalls = append(msg.ToolCalls, ToolCall{ID: b.id, Name: b.name, Args: json.RawMessage(args)})
	}
	return &ChatResponse{Message: msg, StopReason: mapAnthropicStop(stop, len(msg.ToolCalls))}, nil
}

func mapAnthropicStop(reason string, toolCalls int) string {
	switch reason {
	case "tool_use":
		return StopToolUse
	case "max_tokens":
		return StopMaxTokens
	case "refusal":
		return StopRefusal
	default:
		if toolCalls > 0 {
			return StopToolUse
		}
		return StopEndTurn
	}
}

func (p *AnthropicProvider) httpClient() *http.Client {
	if p.HTTP != nil {
		return p.HTTP
	}
	return http.DefaultClient
}
