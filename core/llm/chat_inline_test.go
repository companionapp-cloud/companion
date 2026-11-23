package llm

import (
	"context"
	"encoding/json"
	"testing"
)

// loopingInline asks for a tool `calls` times inside one reply, like Foundation Models does.
type loopingInline struct{ calls int }

func (p *loopingInline) Name() string { return "inline" }
func (p *loopingInline) Chat(context.Context, ChatRequest, DeltaFunc) (*ChatResponse, error) {
	panic("the engine should use ChatWithTools for an inline provider")
}
func (p *loopingInline) ChatWithTools(ctx context.Context, req ChatRequest, invoke ToolInvoker, onDelta DeltaFunc) ([]Message, error) {
	var out []Message
	for i := 0; i < p.calls; i++ {
		call := ToolCall{ID: "c", Name: "ping", Args: json.RawMessage(`{}`)}
		out = append(out, Message{Role: RoleAssistant, ToolCalls: []ToolCall{call}}, Message{Role: RoleTool, ToolResults: []ToolResult{invoke(ctx, call)}})
	}
	return append(out, Message{Role: RoleAssistant, Text: "done"}), nil
}

func TestEngineInlineProvider(t *testing.T) {
	reg := NewRegistry()
	ran := 0
	reg.Add(Tool{Spec: ToolSpec{Name: "ping"}, Handler: func(context.Context, json.RawMessage) (string, error) { ran++; return "pong", nil }})
	events := 0
	e := &Engine{Provider: &loopingInline{calls: 10}, Registry: reg, MaxRounds: 2}
	out, err := e.Run(context.Background(), []Message{{Role: RoleUser, Text: "go"}}, nil, func(ToolEvent) { events++ })
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1+20+1 || out[len(out)-1].Text != "done" {
		t.Fatalf("got %d messages", len(out))
	}
	// MaxRounds 2 allows 8 inline calls; the rest are refused without running.
	if ran != 8 || events != 8 {
		t.Errorf("ran %d tools, reported %d; want 8", ran, events)
	}
	if last := out[len(out)-2].ToolResults[0]; !last.IsError {
		t.Errorf("calls past the cap should be refused: %+v", last)
	}
}
