//go:build !js

package agentrt

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"companion/core/agents"
)

// ClaudeRunner drives the Claude Code CLI in print mode (PLAN-agents.md §4.1):
//
//	claude -p --output-format stream-json --verbose --include-partial-messages [--resume id] …
//
// with the prompt on stdin. Text deltas stream from `stream_event` lines when the CLI emits
// them (newer versions) and fall back to whole `assistant` text blocks otherwise; tool uses
// come from `assistant` content blocks; the terminal `result` line carries the session id.
type ClaudeRunner struct {
	Path string
	// ExtraArgs are appended verbatim (from the agent's settings), e.g. --add-dir.
	ExtraArgs []string
}

// Curated model list: Claude Code resolves aliases itself, so these are what a user would
// realistically pick. "" (default) means the CLI's configured model.
var claudeModels = []string{"default", "opus", "sonnet", "haiku"}

func (r *ClaudeRunner) ListModels(context.Context) ([]string, error) {
	return append([]string(nil), claudeModels...), nil
}

func (r *ClaudeRunner) Run(ctx context.Context, req agents.RunRequest, onDelta func(string), onTool func(agents.ToolUse)) (*agents.RunResult, error) {
	args := []string{"-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"}
	if req.SessionID != "" {
		args = append(args, "--resume", req.SessionID)
	}
	if req.Model != "" && req.Model != "default" {
		args = append(args, "--model", req.Model)
	}
	// Permissions are explicit allowlists, not plan mode: plan mode blocks every MCP tool, which
	// would cut the agent off from Companion's own notes/tasks tools. In print mode any tool
	// outside the allowlist is denied automatically (there is nobody to prompt), so the
	// read-only set is exactly what is listed. mcp__companion covers the whole Companion
	// server; the server itself hides write tools from a read-only grant (core/mcp).
	if req.AllowSystem {
		args = append(args, "--permission-mode", "acceptEdits",
			"--allowedTools", "Read,Glob,Grep,LS,WebFetch,WebSearch,Bash,Edit,Write,MultiEdit,NotebookEdit,mcp__companion")
	} else {
		args = append(args,
			"--allowedTools", "Read,Glob,Grep,LS,WebFetch,WebSearch,mcp__companion",
			"--disallowedTools", "Bash,Edit,Write,MultiEdit,NotebookEdit")
	}
	if req.MCP != nil {
		// Companion's tools reach Claude Code as an MCP server (PLAN-agents.md §4.5). The config
		// file lives in the agent's scratch dir; the token inside it is per-agent and loopback-only.
		cfgPath, err := writeClaudeMCPConfig(req.Cwd, req.MCP)
		if err != nil {
			return nil, err
		}
		args = append(args, "--mcp-config", cfgPath, "--append-system-prompt", companionSystemPrompt)
	}
	args = append(args, r.ExtraArgs...)

	p := &claudeParser{onDelta: onDelta, onTool: onTool}
	err := runJSONL(ctx, req.Cwd, r.Path, args, childEnv(r.Path), req.Prompt, p.line)
	if err != nil {
		if p.errText != "" {
			return nil, errors.New(p.errText)
		}
		return nil, err
	}
	if p.errText != "" {
		return nil, errors.New(p.errText)
	}
	text := p.result
	if text == "" {
		text = p.assistantText.String()
	}
	if text == "" {
		text = p.streamed.String()
	}
	return &agents.RunResult{SessionID: p.sessionID, Text: text, Usage: p.usage}, nil
}

// claudeParser folds the stream-json lines into deltas, tool events and the final result.
type claudeParser struct {
	onDelta func(string)
	onTool  func(agents.ToolUse)

	sessionID string
	result    string
	errText   string
	usage     map[string]any
	// streamed collects partial text deltas; assistantText collects whole assistant blocks.
	// When deltas are present we suppress the whole-block echo to avoid double text.
	streamed      strings.Builder
	assistantText strings.Builder
	sawStream     bool
	// pending tool_use ids → names, so a later tool_result can be attached as Output.
	pendingTools map[string]agents.ToolUse
}

type claudeLine struct {
	Type      string `json:"type"`
	Subtype   string `json:"subtype"`
	SessionID string `json:"session_id"`
	IsError   bool   `json:"is_error"`
	Result    string `json:"result"`
	Error     string `json:"error"`
	Usage     map[string]any
	Message   *struct {
		Content []claudeBlock `json:"content"`
	} `json:"message"`
	Event *struct {
		Type  string `json:"type"`
		Delta *struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"delta"`
	} `json:"event"`
}

type claudeBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
}

func (p *claudeParser) line(raw []byte) {
	var l claudeLine
	if err := json.Unmarshal(raw, &l); err != nil {
		return // not JSON (a warning line); ignore
	}
	if l.SessionID != "" {
		p.sessionID = l.SessionID
	}
	switch l.Type {
	case "stream_event":
		if l.Event != nil && l.Event.Type == "content_block_delta" && l.Event.Delta != nil && l.Event.Delta.Type == "text_delta" {
			p.sawStream = true
			p.streamed.WriteString(l.Event.Delta.Text)
			if p.onDelta != nil {
				p.onDelta(l.Event.Delta.Text)
			}
		}
	case "assistant":
		if l.Message == nil {
			return
		}
		for _, b := range l.Message.Content {
			switch b.Type {
			case "text":
				p.assistantText.WriteString(b.Text)
				if !p.sawStream && p.onDelta != nil {
					p.onDelta(b.Text)
				}
			case "tool_use":
				// Companion's MCP tools arrive as mcp__companion__<tool>; report the bare tool name
				// so the chat renders them like the built-in engine's tools.
				tu := agents.ToolUse{Name: strings.TrimPrefix(b.Name, "mcp__companion__"), Input: compactJSON(b.Input)}
				if p.pendingTools == nil {
					p.pendingTools = map[string]agents.ToolUse{}
				}
				p.pendingTools[b.ID] = tu
				if p.onTool != nil {
					p.onTool(tu)
				}
			}
		}
	case "user":
		// Tool results echo back as user turns; attach them for richer action lines later.
		if l.Message == nil {
			return
		}
		for _, b := range l.Message.Content {
			if b.Type == "tool_result" && p.pendingTools != nil {
				if tu, ok := p.pendingTools[b.ToolUseID]; ok {
					tu.Output = truncate(rawText(b.Content), 2000)
					delete(p.pendingTools, b.ToolUseID)
				}
			}
		}
	case "result":
		p.result = l.Result
		p.usage = l.Usage
		if l.IsError || strings.HasPrefix(l.Subtype, "error") {
			msg := l.Result
			if msg == "" {
				msg = l.Error
			}
			if msg == "" {
				msg = "Claude Code ended with " + l.Subtype
			}
			p.errText = msg
		}
	}
}

// rawText renders a tool_result content value (a string, or an array of text blocks) as text.
func rawText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) == nil {
		var b strings.Builder
		for _, bl := range blocks {
			b.WriteString(bl.Text)
		}
		return b.String()
	}
	return string(raw)
}

func compactJSON(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var buf strings.Builder
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	var v any
	if err := dec.Decode(&v); err != nil {
		return string(raw)
	}
	b, err := json.Marshal(v)
	if err != nil {
		return string(raw)
	}
	buf.Write(b)
	return truncate(buf.String(), 4000)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// companionSystemPrompt tells a CLI agent what the companion MCP tools are for.
const companionSystemPrompt = `You are running inside Companion, the user's notes, tasks, projects, calendar and canvases app. The "companion" MCP tools read and (when permitted) change that workspace: call get_date before reasoning about relative dates, search_notes to find the user's own content, get_note before quoting a note, list_events for their schedule, list_canvases / get_canvas for their boards, and the create_/update_ tools to act. Reference entities with the [[note:…]] / [[task:…]] wikilinks the tools return. To show the user a note, task, event or canvas, call render_note / render_task / render_event / render_canvas — an inline preview appears in the chat — and render_graph to show how something connects; don't paste what a preview shows. Prefer these tools over guessing what the user has written.`

// writeClaudeMCPConfig writes the --mcp-config file for the Companion endpoint.
func writeClaudeMCPConfig(cwd string, ep *agents.MCPEndpoint) (string, error) {
	cfg := map[string]any{
		"mcpServers": map[string]any{
			"companion": map[string]any{
				"type":    "http",
				"url":     ep.URL,
				"headers": map[string]string{"Authorization": "Bearer " + ep.Token},
			},
		},
	}
	b, err := json.Marshal(cfg)
	if err != nil {
		return "", err
	}
	path := filepath.Join(cwd, "companion-mcp.json")
	if err := os.WriteFile(path, b, 0o600); err != nil {
		return "", err
	}
	return path, nil
}
