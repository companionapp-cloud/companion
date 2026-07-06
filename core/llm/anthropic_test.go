//go:build !js

package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAnthropicStreamsTextAndToolUse(t *testing.T) {
	// A realistic Messages SSE: intro text, then a tool_use block whose input streams as
	// input_json_delta fragments, then a message_delta carrying stop_reason: tool_use.
	stream := strings.Join([]string{
		`event: message_start`,
		`data: {"type":"message_start","message":{"id":"msg_1","role":"assistant","content":[]}}`,
		`event: content_block_start`,
		`data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
		`event: content_block_delta`,
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"On it."}}`,
		`event: content_block_stop`,
		`data: {"type":"content_block_stop","index":0}`,
		`event: content_block_start`,
		`data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"create_task","input":{}}}`,
		`event: content_block_delta`,
		`data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"title\":"}}`,
		`event: content_block_delta`,
		`data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"Buy milk\"}"}}`,
		`event: content_block_stop`,
		`data: {"type":"content_block_stop","index":1}`,
		`event: message_delta`,
		`data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}`,
		`event: message_stop`,
		`data: {"type":"message_stop"}`,
		"",
	}, "\n")

	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("anthropic-version") == "" {
			t.Error("missing anthropic-version header")
		}
		if r.Header.Get("x-api-key") != "sk-test" {
			t.Errorf("api key not sent, got %q", r.Header.Get("x-api-key"))
		}
		raw, _ := io.ReadAll(r.Body)
		json.Unmarshal(raw, &gotBody)
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte(stream))
	}))
	defer srv.Close()

	p := &AnthropicProvider{BaseURL: srv.URL, APIKey: "sk-test"}
	var streamed strings.Builder
	resp, err := p.Chat(context.Background(), ChatRequest{
		Model:  "claude-opus-4-8",
		System: "You are helpful.",
		Messages: []Message{
			{Role: RoleUser, Text: "add buy milk"},
		},
		Tools: []ToolSpec{{Name: "create_task", Description: "make a task", Schema: json.RawMessage(`{"type":"object"}`)}},
	}, func(s string) { streamed.WriteString(s) })
	if err != nil {
		t.Fatalf("chat: %v", err)
	}

	if streamed.String() != "On it." || resp.Message.Text != "On it." {
		t.Errorf("text = %q", resp.Message.Text)
	}
	if resp.StopReason != StopToolUse || len(resp.Message.ToolCalls) != 1 {
		t.Fatalf("stop=%q calls=%d", resp.StopReason, len(resp.Message.ToolCalls))
	}
	tc := resp.Message.ToolCalls[0]
	var args map[string]string
	if err := json.Unmarshal(tc.Args, &args); err != nil || args["title"] != "Buy milk" {
		t.Errorf("tool args not reassembled: %q (%v)", tc.Args, err)
	}

	// Request body must carry system, max_tokens, and input_schema-shaped tools.
	if gotBody["system"] != "You are helpful." {
		t.Errorf("system not sent: %v", gotBody["system"])
	}
	if _, ok := gotBody["max_tokens"]; !ok {
		t.Error("max_tokens missing")
	}
	tools, _ := gotBody["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("expected 1 tool in body, got %v", gotBody["tools"])
	}
	tool0 := tools[0].(map[string]any)
	if _, ok := tool0["input_schema"]; !ok {
		t.Errorf("anthropic tool missing input_schema: %v", tool0)
	}
}

// TestAnthropicEncodesToolResultTurn verifies a neutral tool-result message becomes a user
// turn of tool_result blocks (the shape the Messages API requires on continuation).
func TestAnthropicEncodesToolResultTurn(t *testing.T) {
	msgs := encodeAnthropicMessages([]Message{
		{Role: RoleUser, Text: "hi"},
		{Role: RoleAssistant, Text: "", ToolCalls: []ToolCall{{ID: "toolu_1", Name: "create_task", Args: json.RawMessage(`{"title":"x"}`)}}},
		{Role: RoleTool, ToolResults: []ToolResult{{CallID: "toolu_1", Content: `{"id":"t1"}`}}},
	})
	if len(msgs) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(msgs))
	}
	last := msgs[2]
	if last["role"] != "user" {
		t.Errorf("tool result should be a user turn, got %v", last["role"])
	}
	content := last["content"].([]map[string]any)
	if content[0]["type"] != "tool_result" || content[0]["tool_use_id"] != "toolu_1" {
		t.Errorf("bad tool_result block: %v", content[0])
	}
	// The assistant turn must carry the tool_use block.
	asst := msgs[1]["content"].([]map[string]any)
	if asst[0]["type"] != "tool_use" || asst[0]["id"] != "toolu_1" {
		t.Errorf("bad tool_use block: %v", asst[0])
	}
}
