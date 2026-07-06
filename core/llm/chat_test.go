package llm

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// scriptedProvider returns a queued sequence of responses, one per Chat call, recording the
// requests it saw so tests can assert the transcript grew correctly between rounds.
type scriptedProvider struct {
	responses []ChatResponse
	calls     int
	lastReq   ChatRequest
}

func (p *scriptedProvider) Name() string { return "scripted" }

func (p *scriptedProvider) Chat(_ context.Context, req ChatRequest, onDelta DeltaFunc) (*ChatResponse, error) {
	p.lastReq = req
	r := p.responses[p.calls]
	p.calls++
	if onDelta != nil && r.Message.Text != "" {
		onDelta(r.Message.Text)
	}
	return &r, nil
}

func TestEngineRunsToolsThenStops(t *testing.T) {
	reg := NewRegistry()
	var ran string
	reg.Add(Tool{
		Spec:    ToolSpec{Name: "echo", Schema: json.RawMessage(`{"type":"object"}`)},
		Handler: func(_ context.Context, args json.RawMessage) (string, error) { ran = string(args); return "ok", nil },
	})

	prov := &scriptedProvider{responses: []ChatResponse{
		{StopReason: StopToolUse, Message: Message{Role: RoleAssistant, ToolCalls: []ToolCall{
			{ID: "c1", Name: "echo", Args: json.RawMessage(`{"x":1}`)},
		}}},
		{StopReason: StopEndTurn, Message: Message{Role: RoleAssistant, Text: "all done"}},
	}}
	eng := &Engine{Provider: prov, Registry: reg}

	var events []ToolEvent
	var streamed strings.Builder
	msgs, err := eng.Run(context.Background(),
		[]Message{{Role: RoleUser, Text: "do the thing"}},
		func(s string) { streamed.WriteString(s) },
		func(e ToolEvent) { events = append(events, e) },
	)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if ran != `{"x":1}` {
		t.Errorf("tool not run with its args, got %q", ran)
	}
	// user, assistant(tool_use), tool(result), assistant(text) = 4
	if len(msgs) != 4 {
		t.Fatalf("expected 4 messages, got %d: %+v", len(msgs), msgs)
	}
	if msgs[2].Role != RoleTool || msgs[2].ToolResults[0].Content != "ok" {
		t.Errorf("tool result not appended: %+v", msgs[2])
	}
	if len(events) != 1 || events[0].Call.Name != "echo" {
		t.Errorf("onTool not notified: %+v", events)
	}
	if streamed.String() != "all done" {
		t.Errorf("final text not streamed, got %q", streamed.String())
	}
	// The second request must carry the tool result back to the model.
	if prov.lastReq.Messages[len(prov.lastReq.Messages)-1].Role != RoleTool {
		t.Error("tool result was not fed back to the provider")
	}
}

// A failing tool becomes an is_error result the model can see; the loop keeps going.
func TestEngineToolErrorContinues(t *testing.T) {
	reg := NewRegistry()
	reg.Add(Tool{
		Spec:    ToolSpec{Name: "boom", Schema: json.RawMessage(`{"type":"object"}`)},
		Handler: func(_ context.Context, _ json.RawMessage) (string, error) { return "", errors.New("kaboom") },
	})
	prov := &scriptedProvider{responses: []ChatResponse{
		{StopReason: StopToolUse, Message: Message{Role: RoleAssistant, ToolCalls: []ToolCall{{ID: "c1", Name: "boom", Args: json.RawMessage(`{}`)}}}},
		{StopReason: StopEndTurn, Message: Message{Role: RoleAssistant, Text: "recovered"}},
	}}
	eng := &Engine{Provider: prov, Registry: reg}
	msgs, err := eng.Run(context.Background(), []Message{{Role: RoleUser, Text: "go"}}, nil, nil)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	tr := msgs[2].ToolResults[0]
	if !tr.IsError || !strings.Contains(tr.Content, "kaboom") {
		t.Errorf("expected error result, got %+v", tr)
	}
}

// An unknown tool the model hallucinates is reported as an error result, not a hard stop.
func TestEngineUnknownToolIsErrorResult(t *testing.T) {
	prov := &scriptedProvider{responses: []ChatResponse{
		{StopReason: StopToolUse, Message: Message{Role: RoleAssistant, ToolCalls: []ToolCall{{ID: "c1", Name: "nope", Args: json.RawMessage(`{}`)}}}},
		{StopReason: StopEndTurn, Message: Message{Role: RoleAssistant, Text: "ok"}},
	}}
	eng := &Engine{Provider: prov, Registry: NewRegistry()}
	msgs, err := eng.Run(context.Background(), []Message{{Role: RoleUser, Text: "go"}}, nil, nil)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if !msgs[2].ToolResults[0].IsError {
		t.Error("unknown tool should yield an error result")
	}
}
