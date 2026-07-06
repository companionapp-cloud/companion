//go:build !js

package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// sseServer returns an httptest server that replies to each /chat/completions call with the
// next SSE script in turn, so a test can stage a multi-round conversation.
func sseServer(t *testing.T, scripts ...string) *httptest.Server {
	t.Helper()
	call := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/chat/completions") {
			http.Error(w, "wrong path", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		if call < len(scripts) {
			w.Write([]byte(scripts[call]))
		}
		call++
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestOpenAIStreamsTextAndReassemblesToolCall(t *testing.T) {
	// Tool-call arguments arrive fragmented across chunks (keyed by index) — the provider
	// must stitch them back into valid JSON.
	script := strings.Join([]string{
		`data: {"choices":[{"delta":{"content":"Let me "},"finish_reason":null}]}`,
		`data: {"choices":[{"delta":{"content":"check."},"finish_reason":null}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search_notes","arguments":"{\"query\":"}}]},"finish_reason":null}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"pricing\"}"}}]},"finish_reason":null}]}`,
		`data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
		`data: [DONE]`,
		"",
	}, "\n\n")

	srv := sseServer(t, script)
	p := &OpenAIProvider{BaseURL: srv.URL + "/v1"}

	var streamed strings.Builder
	resp, err := p.Chat(context.Background(),
		ChatRequest{Model: "test", Messages: []Message{{Role: RoleUser, Text: "hi"}}},
		func(s string) { streamed.WriteString(s) })
	if err != nil {
		t.Fatalf("chat: %v", err)
	}
	if streamed.String() != "Let me check." {
		t.Errorf("streamed text = %q", streamed.String())
	}
	if resp.StopReason != StopToolUse {
		t.Errorf("stop reason = %q, want tool_use", resp.StopReason)
	}
	if len(resp.Message.ToolCalls) != 1 {
		t.Fatalf("expected 1 tool call, got %d", len(resp.Message.ToolCalls))
	}
	tc := resp.Message.ToolCalls[0]
	if tc.Name != "search_notes" || tc.ID != "call_1" {
		t.Errorf("bad tool call %+v", tc)
	}
	var args map[string]string
	if err := json.Unmarshal(tc.Args, &args); err != nil {
		t.Fatalf("reassembled args are not valid JSON: %q (%v)", tc.Args, err)
	}
	if args["query"] != "pricing" {
		t.Errorf("args = %v", args)
	}
}

// TestOpenAIEmptyAssistantContent guards that an assistant turn carrying only tool calls
// still serializes an explicit (empty) content field — dropping it makes Ollama 400 with
// "invalid message content type: <nil>".
func TestOpenAIEmptyAssistantContent(t *testing.T) {
	p := &OpenAIProvider{}
	msgs := p.encodeMessages(ChatRequest{Messages: []Message{
		{Role: RoleAssistant, ToolCalls: []ToolCall{{ID: "c1", Name: "create_note", Args: json.RawMessage(`{"title":"x"}`)}}},
	}})
	b, _ := json.Marshal(msgs)
	if !strings.Contains(string(b), `"content":""`) {
		t.Errorf("assistant tool-call message must include empty content, got %s", b)
	}
}

// TestOpenAIEngineIntegration drives the full loop over the real provider: round one asks
// for a write tool, round two answers in text. It also proves the request body carries the
// tools and that the encoded transcript round-trips.
func TestOpenAIEngineIntegration(t *testing.T) {
	round1 := strings.Join([]string{
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"create_task","arguments":"{\"title\":\"Buy milk\"}"}}]},"finish_reason":"tool_calls"}]}`,
		`data: [DONE]`,
		"",
	}, "\n\n")
	round2 := strings.Join([]string{
		`data: {"choices":[{"delta":{"content":"Added it."},"finish_reason":"stop"}]}`,
		`data: [DONE]`,
		"",
	}, "\n\n")

	srv := sseServer(t, round1, round2)
	s := newTestStore(t)
	eng := &Engine{
		Provider: &OpenAIProvider{BaseURL: srv.URL + "/v1"},
		Registry: NewStoreRegistry(s),
		Model:    "test",
		System:   "You are a helpful assistant.",
	}

	var events []ToolEvent
	msgs, err := eng.Run(context.Background(),
		[]Message{{Role: RoleUser, Text: "add a task to buy milk"}},
		nil, func(e ToolEvent) { events = append(events, e) })
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if msgs[len(msgs)-1].Text != "Added it." {
		t.Errorf("final message = %q", msgs[len(msgs)-1].Text)
	}
	if len(events) != 1 || events[0].Call.Name != "create_task" {
		t.Fatalf("expected one create_task event, got %+v", events)
	}
	// The task really landed in the store and is findable.
	hits, _ := s.Search.Search("milk", 10)
	if len(hits) != 1 || hits[0].Type != "task" {
		t.Errorf("task not created in store: %+v", hits)
	}
}
