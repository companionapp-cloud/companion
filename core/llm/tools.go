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

// ToolImage is an image a tool returns beside its text (e.g. ink drawn as a PNG).
type ToolImage struct {
	MIMEType string
	Data     []byte
}

// ToolOutput is a tool result with images. Only clients that take image results (CLI agents
// over MCP) receive the images; everyone else gets Text.
type ToolOutput struct {
	Text   string
	Images []ToolImage
}

// RichToolHandler is a ToolHandler whose result may carry images.
type RichToolHandler func(ctx context.Context, args json.RawMessage) (ToolOutput, error)

// Tool couples a ToolSpec advertised to the model with the handler that runs it. Write
// marks state-mutating tools (create/update) apart from read-only retrieval, so the shell
// can render or (later) gate them differently. A tool sets Handler, or Rich when its result
// can include images.
type Tool struct {
	Spec    ToolSpec
	Write   bool
	Handler ToolHandler
	Rich    RichToolHandler
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

// ReadOnly returns a copy of the registry without its write tools, for agents whose
// Companion write access is switched off.
func (r *Registry) ReadOnly() *Registry {
	out := NewRegistry()
	for name, t := range r.tools {
		if !t.Write {
			out.tools[name] = t
		}
	}
	return out
}

// Without returns a copy of the registry minus the named tools.
func (r *Registry) Without(names ...string) *Registry {
	out := NewRegistry()
	for name, t := range r.tools {
		out.tools[name] = t
	}
	for _, name := range names {
		delete(out.tools, name)
	}
	return out
}

// Only returns a copy of the registry holding just the named tools (unknown names are ignored).
func (r *Registry) Only(names ...string) *Registry {
	out := NewRegistry()
	for _, name := range names {
		if t, ok := r.tools[name]; ok {
			out.tools[name] = t
		}
	}
	return out
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
	if t.Handler == nil && t.Rich != nil {
		out, err := t.Rich(ctx, args)
		return out.Text, err
	}
	return t.Handler(ctx, args)
}

// InvokeRich runs the named tool, keeping any images its result carries.
func (r *Registry) InvokeRich(ctx context.Context, name string, args json.RawMessage) (ToolOutput, error) {
	t, ok := r.tools[name]
	if !ok {
		return ToolOutput{}, fmt.Errorf("unknown tool %q", name)
	}
	if t.Rich != nil {
		return t.Rich(ctx, args)
	}
	text, err := t.Handler(ctx, args)
	return ToolOutput{Text: text}, err
}

// jsonResult marshals a handler's structured result to the string the model receives.
func jsonResult(v any) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", fmt.Errorf("marshal tool result: %w", err)
	}
	return string(b), nil
}
