package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
)

// ToolHandler runs a tool's logic against local state. args is the raw JSON the model
// supplied for the call; the returned string becomes the tool-result content fed back to
// the model on the next round.
type ToolHandler func(ctx context.Context, args json.RawMessage) (string, error)

// Tool couples a ToolSpec advertised to the model with the handler that runs it. Write
// marks state-mutating tools (create/update) apart from read-only retrieval, so the shell
// can render or (later) gate them differently.
type Tool struct {
	Spec    ToolSpec
	Write   bool
	Handler ToolHandler
}

// Registry is the set of tools available to the model in a conversation, built once from a
// store (see NewStoreRegistry) and reused across chats.
type Registry struct {
	tools map[string]Tool
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry { return &Registry{tools: map[string]Tool{}} }

// Add registers (or replaces) a tool by name.
func (r *Registry) Add(t Tool) { r.tools[t.Spec.Name] = t }

// Specs returns the advertised tool definitions in name-sorted order, so the tool list
// handed to the model — and therefore the prompt-cache prefix — is deterministic.
func (r *Registry) Specs() []ToolSpec {
	names := make([]string, 0, len(r.tools))
	for n := range r.tools {
		names = append(names, n)
	}
	sort.Strings(names)
	specs := make([]ToolSpec, 0, len(names))
	for _, n := range names {
		specs = append(specs, r.tools[n].Spec)
	}
	return specs
}

// IsWrite reports whether the named tool mutates state (unknown tools report false).
func (r *Registry) IsWrite(name string) bool {
	t, ok := r.tools[name]
	return ok && t.Write
}

// Invoke runs the named tool. A missing tool returns an error the orchestration loop
// reports back to the model as a failed tool result, rather than aborting the conversation.
func (r *Registry) Invoke(ctx context.Context, name string, args json.RawMessage) (string, error) {
	t, ok := r.tools[name]
	if !ok {
		return "", fmt.Errorf("unknown tool %q", name)
	}
	return t.Handler(ctx, args)
}

// jsonResult marshals a handler's structured result to the string the model receives.
func jsonResult(v any) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", fmt.Errorf("marshal tool result: %w", err)
	}
	return string(b), nil
}
