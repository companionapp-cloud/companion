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

	if inline, ok := e.Provider.(InlineToolProvider); ok {
		return e.runInline(ctx, inline, messages, tools, maxRounds, onDelta, onTool)
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
			results = append(results, e.invoke(ctx, tc, onTool))
		}
		messages = append(messages, Message{Role: RoleTool, ToolResults: results})
	}
	return messages, fmt.Errorf("llm: exceeded max tool rounds (%d)", maxRounds)
}

// invoke runs one tool call against the registry and reports it.
func (e *Engine) invoke(ctx context.Context, tc ToolCall, onTool func(ToolEvent)) ToolResult {
	tr := ToolResult{CallID: tc.ID}
	if e.Registry == nil {
		tr.Content, tr.IsError = "no tools are available", true
	} else if content, err := e.Registry.Invoke(ctx, tc.Name, tc.Args); err != nil {
		// Surface the failure to the model as an error result so it can recover, rather than
		// aborting the whole turn.
		tr.Content, tr.IsError = err.Error(), true
	} else {
		tr.Content = content
	}
	if onTool != nil {
		onTool(ToolEvent{Call: tc, Result: tr})
	}
	return tr
}

// runInline drives a provider that runs tools inside its own generation. The same cap applies,
// counted in tool calls (maxRounds × 4) since there are no rounds to count: past it, calls are
// refused so the model has to answer with what it has.
func (e *Engine) runInline(ctx context.Context, p InlineToolProvider, messages []Message, tools []ToolSpec, maxRounds int, onDelta DeltaFunc, onTool func(ToolEvent)) ([]Message, error) {
	budget := maxRounds * 4
	invoke := func(ctx context.Context, tc ToolCall) ToolResult {
		if budget <= 0 {
			return ToolResult{CallID: tc.ID, Content: "tool call limit reached; answer with what you have", IsError: true}
		}
		budget--
		return e.invoke(ctx, tc, onTool)
	}
	added, err := p.ChatWithTools(ctx, ChatRequest{Model: e.Model, System: e.System, Messages: messages, Tools: tools}, invoke, onDelta)
	return append(messages, added...), err
}
