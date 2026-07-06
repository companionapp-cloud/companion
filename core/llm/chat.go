package llm

import (
	"context"
	"fmt"
)

// defaultMaxRounds caps how many provider↔tool cycles one user turn may take, so a model
// that loops on tool calls can't run unbounded.
const defaultMaxRounds = 8

// ToolEvent reports one executed tool call and its result, so the shell can render the
// action in the chat transcript (e.g. "Created [[task:…]]").
type ToolEvent struct {
	Call   ToolCall   `json:"call"`
	Result ToolResult `json:"result"`
}

// Engine runs the agentic loop for a conversation: it owns the Provider, the tool Registry,
// the system prompt, and the model id. The same Engine drives every platform, so "ask my
// data" behaves identically everywhere (PLAN §6.8).
type Engine struct {
	Provider  Provider
	Registry  *Registry
	System    string
	Model     string
	MaxRounds int
}

// Run advances the conversation by one user turn to completion. messages is the full
// transcript including the just-appended user message; Run returns it extended with the
// assistant turns and any tool-result turns produced along the way. Text streams through
// onDelta; each executed tool is reported to onTool. Both callbacks may be nil.
//
// Write tools are auto-applied and reported after the fact (the create/update already
// happened against local SQLite, which is Trash-recoverable) — matching the chat UX where
// the assistant performs the action and cites the resulting entity.
func (e *Engine) Run(ctx context.Context, messages []Message, onDelta DeltaFunc, onTool func(ToolEvent)) ([]Message, error) {
	maxRounds := e.MaxRounds
	if maxRounds <= 0 {
		maxRounds = defaultMaxRounds
	}
	var tools []ToolSpec
	if e.Registry != nil {
		tools = e.Registry.Specs()
	}

	for round := 0; round < maxRounds; round++ {
		resp, err := e.Provider.Chat(ctx, ChatRequest{
			Model:    e.Model,
			System:   e.System,
			Messages: messages,
			Tools:    tools,
		}, onDelta)
		if err != nil {
			return messages, err
		}
		messages = append(messages, resp.Message)

		if len(resp.Message.ToolCalls) == 0 {
			return messages, nil
		}

		results := make([]ToolResult, 0, len(resp.Message.ToolCalls))
		for _, tc := range resp.Message.ToolCalls {
			content, err := e.Registry.Invoke(ctx, tc.Name, tc.Args)
			tr := ToolResult{CallID: tc.ID, Content: content}
			if err != nil {
				// Surface the failure to the model as an error result so it can recover,
				// rather than aborting the whole turn.
				tr.Content = err.Error()
				tr.IsError = true
			}
			results = append(results, tr)
			if onTool != nil {
				onTool(ToolEvent{Call: tc, Result: tr})
			}
		}
		messages = append(messages, Message{Role: RoleTool, ToolResults: results})
	}
	return messages, fmt.Errorf("llm: exceeded max tool rounds (%d)", maxRounds)
}
