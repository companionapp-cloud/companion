// Package llm implements Companion's on-device chat orchestration (PLAN §6.8): a
// provider-neutral message/tool model, two Provider implementations (an OpenAI-compatible
// client that also covers Ollama/LM Studio, and an Anthropic client), a registry of tools
// the model can call locally against SQLite, and the agentic loop that ties them together.
//
// The loop runs identically on every platform because it lives here in the shared Go core,
// so "ask my data" behaves the same on desktop, web, and mobile, and private data only
// leaves the device as the context the user's chosen model receives.
package llm

import (
	"context"
	"encoding/json"
)

// Role identifies the author of a Message in the neutral transcript. Providers translate
// these to their own wire vocabulary.
const (
	RoleUser      = "user"
	RoleAssistant = "assistant"
	RoleTool      = "tool"
)

// Stop reasons a provider reports, normalized across wire formats.
const (
	StopEndTurn   = "end_turn"   // the model finished its answer
	StopToolUse   = "tool_use"   // the model wants one or more tools run
	StopMaxTokens = "max_tokens" // output was truncated at the token cap
	StopRefusal   = "refusal"    // the model declined (Anthropic safety classifier)
)

// Message is one turn in the provider-neutral transcript. A single message carries at most
// one kind of payload: assistant messages may carry Text and/or ToolCalls; a tool message
// carries ToolResults; a user message carries Text.
type Message struct {
	Role        string       `json:"role"`
	Text        string       `json:"text,omitempty"`
	ToolCalls   []ToolCall   `json:"toolCalls,omitempty"`
	ToolResults []ToolResult `json:"toolResults,omitempty"`
}

// ToolCall is the model's request to run a tool with the given JSON arguments. ID is the
// provider-assigned handle a matching ToolResult must echo back.
type ToolCall struct {
	ID   string          `json:"id"`
	Name string          `json:"name"`
	Args json.RawMessage `json:"args"`
}

// ToolResult is the outcome of running a ToolCall, fed back to the model on the next round.
// CallID matches the originating ToolCall.ID; IsError marks a failed run so the model can
// recover rather than treating the error text as data.
type ToolResult struct {
	CallID  string `json:"callId"`
	Content string `json:"content"`
	IsError bool   `json:"isError"`
}

// ToolSpec is a tool definition advertised to the model: a name, a prescriptive
// description (say *when* to call it, not just what it does), and a JSON Schema for its
// arguments. Providers render this into their own tool shape.
type ToolSpec struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Schema      json.RawMessage `json:"schema"`
}

// ChatRequest is one round of a conversation handed to a Provider: the model id, an
// optional system prompt, the transcript so far, and the tools on offer.
type ChatRequest struct {
	Model    string
	System   string
	Messages []Message
	Tools    []ToolSpec
}

// ChatResponse is the assistant turn a Provider produced, plus why it stopped. When
// StopReason is StopToolUse, Message.ToolCalls is non-empty and the orchestrator runs them.
type ChatResponse struct {
	Message    Message
	StopReason string
}

// DeltaFunc receives incremental assistant text as it streams, so the UI can render tokens
// live (surfaced to the shell as llm.token events). It is called only for text, never for
// tool-call arguments.
type DeltaFunc func(text string)

// Provider is one backend (OpenAI-compatible or Anthropic). Chat sends a single round and
// returns the assistant's message; the agentic loop, not the Provider, decides whether to
// continue after tool calls. onDelta may be nil when the caller does not need streaming.
type Provider interface {
	// Name is a stable identifier for logs and errors (e.g. "openai", "anthropic").
	Name() string
	// Chat runs one request/response round, streaming text through onDelta as it arrives.
	Chat(ctx context.Context, req ChatRequest, onDelta DeltaFunc) (*ChatResponse, error)
}

// ModelLister is an optional capability a Provider may implement: fetch the models the
// configured endpoint currently offers (e.g. the models installed in Ollama, or the models a
// cloud key can reach), so the UI can let the user pick one at chat time rather than baking it
// into the config. Both concrete providers implement it.
type ModelLister interface {
	// ListModels returns the available model ids, sorted. It hits the provider's models
	// endpoint and so may fail on network/auth errors.
	ListModels(ctx context.Context) ([]string, error)
}
