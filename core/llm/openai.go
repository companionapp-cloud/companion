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

// OpenAIProvider speaks the OpenAI Chat Completions wire format, which also covers Ollama,
// LM Studio, llama.cpp's server, OpenRouter, and anything else OpenAI-compatible (PLAN
// §6.8). BaseURL is the /v1 root (e.g. https://api.openai.com/v1 or, for a local model,
// http://localhost:11434/v1); APIKey is empty for local servers. Implemented over raw
// net/http rather than an SDK so the streaming plugs straight into our event channel and
// the wasm/gomobile binaries stay lean.
type OpenAIProvider struct {
	BaseURL string
	APIKey  string
	HTTP    *http.Client
}

func (p *OpenAIProvider) Name() string { return "openai" }

// oaMessage / oaTool are the wire shapes for the request body.
type oaMessage struct {
	Role string `json:"role"`
	// content is always emitted (no omitempty): an assistant message that carries only
	// tool_calls has empty text, and dropping the field entirely makes strict servers (e.g.
	// Ollama) reject it with "invalid message content type: <nil>". An empty string is
	// accepted by both OpenAI and Ollama.
	Content    string       `json:"content"`
	ToolCalls  []oaToolCall `json:"tool_calls,omitempty"`
	ToolCallID string       `json:"tool_call_id,omitempty"`
}

type oaToolCall struct {
	ID       string `json:"id"`
	Index    int    `json:"index,omitempty"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

// Chat runs one round against /chat/completions with streaming enabled, forwarding text
// deltas to onDelta and accumulating any tool calls, then returns the assistant message.
func (p *OpenAIProvider) Chat(ctx context.Context, req ChatRequest, onDelta DeltaFunc) (*ChatResponse, error) {
	body := map[string]any{
		"model":    req.Model,
		"messages": p.encodeMessages(req),
		"stream":   true,
	}
	if len(req.Tools) > 0 {
		body["tools"] = encodeOpenAITools(req.Tools)
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(p.BaseURL, "/")+"/chat/completions", bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	if p.APIKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+p.APIKey)
	}
	resp, err := p.httpClient().Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, apiError(p.Name(), resp)
	}
	return p.readStream(resp.Body, onDelta)
}

// ListModels fetches the models the endpoint offers via GET /models (the OpenAI-compatible
// listing, which Ollama, LM Studio, and OpenRouter all serve), returning their ids sorted.
func (p *OpenAIProvider) ListModels(ctx context.Context) ([]string, error) {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet,
		strings.TrimRight(p.BaseURL, "/")+"/models", nil)
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Accept", "application/json")
	if p.APIKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+p.APIKey)
	}
	resp, err := p.httpClient().Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, apiError(p.Name(), resp)
	}
	var body struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("%s: decode models: %w", p.Name(), err)
	}
	ids := make([]string, 0, len(body.Data))
	for _, m := range body.Data {
		if m.ID != "" {
			ids = append(ids, m.ID)
		}
	}
	sort.Strings(ids)
	return ids, nil
}

// encodeMessages flattens the neutral transcript into OpenAI messages: the system prompt
// leads, tool results each become their own tool-role message.
func (p *OpenAIProvider) encodeMessages(req ChatRequest) []oaMessage {
	out := []oaMessage{}
	if req.System != "" {
		out = append(out, oaMessage{Role: "system", Content: req.System})
	}
	for _, m := range req.Messages {
		switch m.Role {
		case RoleTool:
			for _, tr := range m.ToolResults {
				out = append(out, oaMessage{Role: "tool", ToolCallID: tr.CallID, Content: tr.Content})
			}
		case RoleAssistant:
			am := oaMessage{Role: "assistant", Content: m.Text}
			for _, tc := range m.ToolCalls {
				oc := oaToolCall{ID: tc.ID, Type: "function"}
				oc.Function.Name = tc.Name
				oc.Function.Arguments = string(tc.Args)
				am.ToolCalls = append(am.ToolCalls, oc)
			}
			out = append(out, am)
		default:
			out = append(out, oaMessage{Role: "user", Content: m.Text})
		}
	}
	return out
}

func encodeOpenAITools(tools []ToolSpec) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, t := range tools {
		out = append(out, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        t.Name,
				"description": t.Description,
				"parameters":  json.RawMessage(t.Schema),
			},
		})
	}
	return out
}

// readStream consumes the SSE body, streaming text through onDelta and reassembling tool
// calls whose arguments arrive fragmented across chunks (keyed by index).
func (p *OpenAIProvider) readStream(body io.Reader, onDelta DeltaFunc) (*ChatResponse, error) {
	type accum struct {
		id, name string
		args     strings.Builder
	}
	tools := map[int]*accum{}
	var text strings.Builder
	finish := ""

	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content   string       `json:"content"`
					ToolCalls []oaToolCall `json:"tool_calls"`
				} `json:"delta"`
				FinishReason string `json:"finish_reason"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			return nil, fmt.Errorf("openai: decode stream chunk: %w", err)
		}
		if len(chunk.Choices) == 0 {
			continue
		}
		ch := chunk.Choices[0]
		if ch.Delta.Content != "" {
			text.WriteString(ch.Delta.Content)
			if onDelta != nil {
				onDelta(ch.Delta.Content)
			}
		}
		for _, tc := range ch.Delta.ToolCalls {
			a := tools[tc.Index]
			if a == nil {
				a = &accum{}
				tools[tc.Index] = a
			}
			if tc.ID != "" {
				a.id = tc.ID
			}
			if tc.Function.Name != "" {
				a.name = tc.Function.Name
			}
			a.args.WriteString(tc.Function.Arguments)
		}
		if ch.FinishReason != "" {
			finish = ch.FinishReason
		}
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("openai: read stream: %w", err)
	}

	msg := Message{Role: RoleAssistant, Text: text.String()}
	indexes := make([]int, 0, len(tools))
	for idx := range tools {
		indexes = append(indexes, idx)
	}
	sort.Ints(indexes)
	for _, idx := range indexes {
		a := tools[idx]
		args := a.args.String()
		if args == "" {
			args = "{}"
		}
		msg.ToolCalls = append(msg.ToolCalls, ToolCall{ID: a.id, Name: a.name, Args: json.RawMessage(args)})
	}
	return &ChatResponse{Message: msg, StopReason: mapOpenAIFinish(finish, len(msg.ToolCalls))}, nil
}

func mapOpenAIFinish(reason string, toolCalls int) string {
	switch reason {
	case "tool_calls":
		return StopToolUse
	case "length":
		return StopMaxTokens
	default:
		if toolCalls > 0 {
			return StopToolUse
		}
		return StopEndTurn
	}
}

func (p *OpenAIProvider) httpClient() *http.Client {
	if p.HTTP != nil {
		return p.HTTP
	}
	return http.DefaultClient
}

// apiError builds a readable error from a non-200 provider response, including a truncated
// body so the caller can see the provider's own message.
func apiError(provider string, resp *http.Response) error {
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	return fmt.Errorf("%s: http %d: %s", provider, resp.StatusCode, strings.TrimSpace(string(b)))
}
