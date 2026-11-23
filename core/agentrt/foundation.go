//go:build !js

package agentrt

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"companion/core/agents"
	"companion/core/ink"
	"companion/core/llm"
)

// Apple Foundation Models (the on-device Apple Intelligence model). The framework is Swift-only,
// so the desktop ships a small helper, companion-fm (apps/desktop/foundation/main.swift), next to
// its binary and drives it over newline-delimited JSON: one process per request.

const runtimeAppleFoundation = "apple-foundation"

// FoundationHelperName is the helper binary's file name, looked up beside the app binary.
const FoundationHelperName = "companion-fm"

// foundationHistoryBudget caps the characters of earlier turns replayed into a request. The
// on-device model's context is small (4K–8K tokens) and also holds the instructions and tool
// definitions, so only the most recent turns travel.
const foundationHistoryBudget = 6000

// FoundationModel is one Apple model as the helper reports it.
type FoundationModel struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Available   bool   `json:"available"`
	Reason      string `json:"reason,omitempty"`
	ContextSize int    `json:"contextSize,omitempty"`
}

// FoundationModels is the desktop's handle on the helper. The zero value is unusable; build it
// with NewFoundationModels, which returns nil where the helper isn't installed.
type FoundationModels struct {
	HelperPath string

	mu        sync.Mutex
	checked   time.Time
	lastCheck []FoundationModel
}

// NewFoundationModels finds the helper (COMPANION_FM_HELPER, else beside the running binary) on
// macOS and returns nil when there is none, so shells inject nothing on other platforms.
func NewFoundationModels() *FoundationModels {
	if runtime.GOOS != "darwin" {
		return nil
	}
	if p := os.Getenv("COMPANION_FM_HELPER"); p != "" && isExecutable(p) {
		return &FoundationModels{HelperPath: p}
	}
	exe, err := os.Executable()
	if err != nil {
		return nil
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	if p := filepath.Join(filepath.Dir(exe), FoundationHelperName); isExecutable(p) {
		return &FoundationModels{HelperPath: p}
	}
	return nil
}

// checkTTL keeps model availability from re-spawning the helper on every model-list request.
const checkTTL = 30 * time.Second

// Check reports the Apple models on this Mac and whether each can run right now.
func (f *FoundationModels) Check(ctx context.Context) ([]FoundationModel, error) {
	f.mu.Lock()
	if f.lastCheck != nil && time.Since(f.checked) < checkTTL {
		out := f.lastCheck
		f.mu.Unlock()
		return out, nil
	}
	f.mu.Unlock()

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, f.HelperPath, "check").Output()
	if err != nil {
		return nil, fmt.Errorf("apple intelligence: %w", err)
	}
	var body struct {
		Models []FoundationModel `json:"models"`
	}
	if err := json.Unmarshal(out, &body); err != nil {
		return nil, fmt.Errorf("apple intelligence: bad check output: %w", err)
	}
	f.mu.Lock()
	f.lastCheck, f.checked = body.Models, time.Now()
	f.mu.Unlock()
	return body.Models, nil
}

// Discover is the discovery probe: an Apple Intelligence card when the helper is present, marked
// not ready (with the system's reason) when the model can't run yet.
func (f *FoundationModels) Discover(ctx context.Context) *agents.Discovered {
	if f == nil {
		return nil
	}
	models, err := f.Check(ctx)
	if err != nil || len(models) == 0 {
		return nil
	}
	found := &agents.Discovered{Runtime: runtimeAppleFoundation, Name: "Apple Intelligence", Status: agents.StatusReady}
	reason := ""
	for _, m := range models {
		if m.Available {
			found.Models = append(found.Models, m.ID)
		} else if reason == "" {
			reason = m.Reason
		}
	}
	if len(found.Models) == 0 {
		found.Status = agents.StatusNotRunning
		found.Detail = reason
	}
	return found
}

// Provider returns the llm.Provider that runs chats on this Mac's Apple models.
func (f *FoundationModels) Provider(opts agents.FoundationOptions) llm.Provider {
	return &FoundationProvider{fm: f, opts: opts}
}

// FoundationProvider speaks to the helper. It implements llm.InlineToolProvider because the
// framework calls tools mid-generation, and llm.ModelLister for the chat model picker.
type FoundationProvider struct {
	fm   *FoundationModels
	opts agents.FoundationOptions
	// Observe, when set, receives the helper's diagnostic events: "usage" (setupTokens),
	// "trace" (catalog-mode steps) and "done" (contextTokens). Used by the evaluation.
	Observe func(kind string, ev map[string]any)
}

func (p *FoundationProvider) Name() string { return runtimeAppleFoundation }

// ListModels returns the Apple models that can run right now.
func (p *FoundationProvider) ListModels(ctx context.Context) ([]string, error) {
	models, err := p.fm.Check(ctx)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	reason := ""
	for _, m := range models {
		if m.Available {
			ids = append(ids, m.ID)
		} else if reason == "" {
			reason = m.Reason
		}
	}
	if len(ids) == 0 && reason != "" {
		return nil, errors.New(reason)
	}
	return ids, nil
}

// Chat runs one tool-free completion (editor assists, titles, compaction).
func (p *FoundationProvider) Chat(ctx context.Context, req llm.ChatRequest, onDelta llm.DeltaFunc) (*llm.ChatResponse, error) {
	req.Tools = nil
	msgs, err := p.ChatWithTools(ctx, req, nil, onDelta)
	if err != nil {
		var re *refusalError
		if errors.As(err, &re) {
			return &llm.ChatResponse{Message: llm.Message{Role: llm.RoleAssistant}, StopReason: llm.StopRefusal}, nil
		}
		return nil, err
	}
	last := llm.Message{Role: llm.RoleAssistant}
	if len(msgs) > 0 {
		last = msgs[len(msgs)-1]
	}
	return &llm.ChatResponse{Message: last, StopReason: llm.StopEndTurn}, nil
}

// refusalError marks a guardrail refusal so Chat can report it as a stop reason.
type refusalError struct{ msg string }

func (e *refusalError) Error() string { return e.msg }

type fmTurn struct {
	Role string `json:"role"`
	Text string `json:"text"`
}

type fmRequest struct {
	Model   string          `json:"model"`
	System  string          `json:"system,omitempty"`
	History []fmTurn        `json:"history"`
	Prompt  string          `json:"prompt"`
	Tools   []llm.ToolSpec  `json:"tools,omitempty"`
	Catalog []fmCatalogTool `json:"catalog,omitempty"`
}

// fmCatalogTool is a catalog entry: the full spec (for filling in arguments) plus its menu line.
type fmCatalogTool struct {
	llm.ToolSpec
	Blurb string `json:"blurb,omitempty"`
}

type fmEvent struct {
	Type    string `json:"type"`
	Text    string `json:"text"`
	ID      string `json:"id"`
	Name    string `json:"name"`
	Args    string `json:"args"`
	Message string `json:"message"`
	Code    string `json:"code"`
}

// ChatWithTools runs one user turn on the helper, answering its tool calls through invoke.
func (p *FoundationProvider) ChatWithTools(ctx context.Context, req llm.ChatRequest, invoke llm.ToolInvoker, onDelta llm.DeltaFunc) ([]llm.Message, error) {
	wire, err := foundationRequest(req)
	if err != nil {
		return nil, err
	}
	if invoke == nil {
		wire.Tools = nil
	} else if p.opts.Short {
		wire.Tools = shortenTools(wire.Tools, p.opts.Blurbs)
	} else if p.opts.Catalog {
		var catalog []llm.ToolSpec
		wire.Tools, catalog = splitTools(wire.Tools, p.opts.Direct)
		for _, t := range catalog {
			wire.Catalog = append(wire.Catalog, fmCatalogTool{ToolSpec: t, Blurb: p.opts.Blurbs[t.Name]})
		}
	}
	line, err := json.Marshal(wire)
	if err != nil {
		return nil, err
	}

	cmd := exec.CommandContext(ctx, p.fm.HelperPath, "run")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var stderr strings.Builder
	cmd.Stderr = &limitedWriter{w: &stderr, n: 4096}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("apple intelligence: %w", err)
	}
	defer func() {
		_ = stdin.Close()
		_ = cmd.Wait()
	}()
	if _, err := stdin.Write(append(line, '\n')); err != nil {
		return nil, fmt.Errorf("apple intelligence: %w", err)
	}

	var out []llm.Message
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 64<<10), 8<<20)
	for sc.Scan() {
		var ev fmEvent
		if json.Unmarshal(sc.Bytes(), &ev) != nil {
			continue
		}
		if p.Observe != nil && (ev.Type == "usage" || ev.Type == "trace" || ev.Type == "done") {
			var raw map[string]any
			if json.Unmarshal(sc.Bytes(), &raw) == nil {
				p.Observe(ev.Type, raw)
			}
		}
		switch ev.Type {
		case "delta":
			if onDelta != nil && ev.Text != "" {
				onDelta(ev.Text)
			}
		case "tool_call":
			args := json.RawMessage(ev.Args)
			if !json.Valid(args) {
				args = json.RawMessage("{}")
			}
			call := llm.ToolCall{ID: ev.ID, Name: ev.Name, Args: args}
			res := llm.ToolResult{CallID: ev.ID, Content: "no tools are available", IsError: true}
			if invoke != nil {
				res = invoke(ctx, call)
				res.CallID = ev.ID
			}
			out = append(out,
				llm.Message{Role: llm.RoleAssistant, ToolCalls: []llm.ToolCall{call}},
				llm.Message{Role: llm.RoleTool, ToolResults: []llm.ToolResult{res}})
			reply, _ := json.Marshal(map[string]any{"type": "tool_result", "id": ev.ID, "content": res.Content, "isError": res.IsError})
			if _, err := stdin.Write(append(reply, '\n')); err != nil {
				return out, fmt.Errorf("apple intelligence: %w", err)
			}
		case "done":
			out = append(out, llm.Message{Role: llm.RoleAssistant, Text: ev.Text})
			return out, nil
		case "error":
			if ev.Code == "refusal" {
				return out, &refusalError{msg: ev.Message}
			}
			return out, errors.New(ev.Message)
		}
	}
	if ctx.Err() != nil {
		return out, ctx.Err()
	}
	if err := sc.Err(); err != nil {
		return out, fmt.Errorf("apple intelligence: %w", err)
	}
	msg := strings.TrimSpace(stderr.String())
	if msg == "" {
		msg = "the helper exited without a reply"
	}
	return out, errors.New("apple intelligence: " + msg)
}

// foundationRequest maps the neutral transcript onto the helper's shape: the last user message
// is the prompt, earlier text turns (newest first, within budget) are history. Tool traffic from
// earlier turns isn't replayed; its outcome is in the assistant text that followed it.
func foundationRequest(req llm.ChatRequest) (fmRequest, error) {
	model := req.Model
	if model == "" {
		model = "apple-on-device"
	}
	last := -1
	for i := len(req.Messages) - 1; i >= 0; i-- {
		if req.Messages[i].Role == llm.RoleUser {
			last = i
			break
		}
	}
	if last < 0 {
		return fmRequest{}, errors.New("apple intelligence: no user message to answer")
	}
	var history []fmTurn
	budget := foundationHistoryBudget
	for i := last - 1; i >= 0 && budget > 0; i-- {
		m := req.Messages[i]
		text := strings.TrimSpace(m.Text)
		if text == "" || (m.Role != llm.RoleUser && m.Role != llm.RoleAssistant) {
			continue
		}
		if len(text) > budget {
			break
		}
		budget -= len(text)
		history = append(history, fmTurn{Role: m.Role, Text: text})
	}
	for i, j := 0, len(history)-1; i < j; i, j = i+1, j-1 {
		history[i], history[j] = history[j], history[i]
	}
	if history == nil {
		history = []fmTurn{}
	}
	return fmRequest{Model: model, System: req.System, History: history, Prompt: req.Messages[last].Text, Tools: req.Tools}, nil
}

// shortenTools trims tool definitions for a small context without hiding anything: each
// description becomes its blurb (or first sentence), and each argument's description its first
// clause. The schemas' structure — names, types, enums, required — is untouched, so the model
// can call every tool exactly as before.
func shortenTools(tools []llm.ToolSpec, blurbs map[string]string) []llm.ToolSpec {
	out := make([]llm.ToolSpec, 0, len(tools))
	for _, t := range tools {
		if b := blurbs[t.Name]; b != "" {
			t.Description = b
		} else {
			t.Description = firstClause(t.Description, 160)
		}
		var schema any
		if json.Unmarshal(t.Schema, &schema) == nil {
			if b, err := json.Marshal(shortenSchema(schema)); err == nil {
				t.Schema = b
			}
		}
		out = append(out, t)
	}
	return out
}

func shortenSchema(v any) any {
	switch x := v.(type) {
	case map[string]any:
		for k, child := range x {
			if k == "description" {
				if s, ok := child.(string); ok {
					x[k] = firstClause(strings.TrimPrefix(strings.TrimPrefix(s, "Optional, "), "Optional "), 80)
				}
				continue
			}
			x[k] = shortenSchema(child)
		}
		return x
	case []any:
		for i := range x {
			x[i] = shortenSchema(x[i])
		}
	}
	return v
}

// firstClause cuts s at its first sentence or clause break (". ", ": ", " — ") and to at most max
// bytes on a word boundary.
func firstClause(s string, max int) string {
	s = strings.TrimSpace(s)
	for _, sep := range []string{". ", ": ", " — ", "; "} {
		if i := strings.Index(s, sep); i > 0 {
			s = s[:i]
		}
	}
	if len(s) > max {
		cut := strings.LastIndex(s[:max], " ")
		if cut <= 0 {
			cut = max
		}
		s = s[:cut] + "…"
	}
	return strings.TrimSuffix(s, ".")
}

// splitTools puts the tools named in direct up front and the rest in the catalog.
func splitTools(tools []llm.ToolSpec, direct []string) (up, catalog []llm.ToolSpec) {
	keep := map[string]bool{}
	for _, n := range direct {
		keep[n] = true
	}
	for _, t := range tools {
		if keep[t.Name] {
			up = append(up, t)
		} else {
			catalog = append(catalog, t)
		}
	}
	return up, catalog
}

// limitedWriter keeps the first n bytes written to it and drops the rest.
type limitedWriter struct {
	w io.Writer
	n int
}

func (l *limitedWriter) Write(p []byte) (int, error) {
	if l.n > 0 {
		k := min(len(p), l.n)
		_, _ = l.w.Write(p[:k])
		l.n -= k
	}
	return len(p), nil
}

// RecognizeInk reads handwriting with Apple Vision through the helper's ocr command
// (ink.Recognizer). Vision runs on-device and needs no Apple Intelligence.
func (f *FoundationModels) RecognizeInk(ctx context.Context, images [][]byte) ([][]ink.Line, error) {
	if len(images) == 0 {
		return nil, nil
	}
	encoded := make([]string, len(images))
	for i, img := range images {
		encoded[i] = base64.StdEncoding.EncodeToString(img)
	}
	req, err := json.Marshal(map[string]any{"images": encoded})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, f.HelperPath, "ocr")
	cmd.Stdin = strings.NewReader(string(req))
	var stderr strings.Builder
	cmd.Stderr = &limitedWriter{w: &stderr, n: 4096}
	out, runErr := cmd.Output()
	var body struct {
		Results [][]ink.Line `json:"results"`
		Type    string       `json:"type"`
		Message string       `json:"message"`
	}
	if err := json.Unmarshal(out, &body); err == nil && body.Type == "error" {
		return nil, errors.New(body.Message)
	}
	if runErr != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return nil, fmt.Errorf("%w: %s", runErr, msg)
		}
		return nil, runErr
	}
	if err := json.Unmarshal(out, &body); err != nil {
		return nil, fmt.Errorf("bad ocr output: %w", err)
	}
	return body.Results, nil
}
