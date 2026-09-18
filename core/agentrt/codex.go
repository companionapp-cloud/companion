//go:build !js

package agentrt

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"companion/core/agents"
)

// CodexRunner drives the OpenAI Codex CLI non-interactively (PLAN-agents.md §4.2):
//
//	codex exec --json [--model m] [--sandbox read-only|workspace-write] --skip-git-repo-check -
//	codex exec resume <thread_id> --json … -
//
// with the prompt on stdin ("-"). Codex emits JSONL events; two generations of shape are
// tolerated: the item-based stream (`item.completed` with `agent_message` / `command_execution`
// items, `thread.started` for the id) and the older `msg`-wrapped events.
type CodexRunner struct {
	Path      string
	ExtraArgs []string
}

var codexModels = []string{"default", "gpt-5-codex", "gpt-5", "o3", "o4-mini"}

func (r *CodexRunner) ListModels(context.Context) ([]string, error) {
	return append([]string(nil), codexModels...), nil
}

func (r *CodexRunner) Run(ctx context.Context, req agents.RunRequest, onDelta func(string), onTool func(agents.ToolUse)) (*agents.RunResult, error) {
	args := []string{"exec"}
	if req.SessionID != "" {
		args = append(args, "resume", req.SessionID)
	}
	args = append(args, "--json", "--skip-git-repo-check")
	if req.Model != "" && req.Model != "default" {
		args = append(args, "--model", req.Model)
	}
	if req.AllowSystem {
		args = append(args, "--sandbox", "workspace-write")
	} else {
		args = append(args, "--sandbox", "read-only")
	}
	if req.Cwd != "" && req.SessionID == "" {
		args = append(args, "-C", req.Cwd)
	}
	env := childEnv(r.Path)
	prompt := req.Prompt
	if req.MCP != nil {
		// Companion's tools as a Streamable-HTTP MCP server, configured through -c overrides so
		// the user's own ~/.codex/config.toml is untouched. The token travels in an env var.
		args = append(args,
			"-c", `mcp_servers.companion.url="`+req.MCP.URL+`"`,
			"-c", `mcp_servers.companion.bearer_token_env_var="COMPANION_MCP_TOKEN"`,
		)
		env = append(env, "COMPANION_MCP_TOKEN="+req.MCP.Token)
		if req.SessionID == "" {
			// Codex has no system-prompt flag; frame the first turn of a session instead.
			prompt = companionSystemPrompt + "\n\n" + prompt
		}
	}
	args = append(args, r.ExtraArgs...)
	args = append(args, "-") // prompt from stdin

	p := &codexParser{onDelta: onDelta, onTool: onTool}
	err := runJSONL(ctx, req.Cwd, r.Path, args, env, prompt, p.line)
	if err != nil {
		if p.errText != "" {
			return nil, errors.New(p.errText)
		}
		return nil, err
	}
	if p.errText != "" && p.text.Len() == 0 {
		return nil, errors.New(p.errText)
	}
	return &agents.RunResult{SessionID: p.sessionID, Text: p.text.String(), Usage: p.usage}, nil
}

type codexParser struct {
	onDelta func(string)
	onTool  func(agents.ToolUse)

	sessionID string
	errText   string
	usage     map[string]any
	text      strings.Builder
}

type codexLine struct {
	Type     string         `json:"type"`
	ThreadID string         `json:"thread_id"`
	Message  string         `json:"message"`
	Usage    map[string]any `json:"usage"`
	Error    *struct {
		Message string `json:"message"`
	} `json:"error"`
	Item *struct {
		Type             string `json:"type"`
		Text             string `json:"text"`
		Command          string `json:"command"`
		AggregatedOutput string `json:"aggregated_output"`
		Status           string `json:"status"`
		Changes          []struct {
			Path string `json:"path"`
			Kind string `json:"kind"`
		} `json:"changes"`
		Server    string          `json:"server"`
		Tool      string          `json:"tool"`
		Arguments json.RawMessage `json:"arguments"`
		Query     string          `json:"query"`
	} `json:"item"`
	// Legacy shape: {"id":"..","msg":{"type":"agent_message","message":".."}}
	Msg *struct {
		Type      string `json:"type"`
		Message   string `json:"message"`
		SessionID string `json:"session_id"`
		Delta     string `json:"delta"`
	} `json:"msg"`
}

func (p *codexParser) line(raw []byte) {
	var l codexLine
	if err := json.Unmarshal(raw, &l); err != nil {
		return
	}
	if l.ThreadID != "" {
		p.sessionID = l.ThreadID
	}
	switch l.Type {
	case "item.completed":
		if l.Item == nil {
			return
		}
		switch l.Item.Type {
		case "agent_message":
			p.emitText(l.Item.Text)
		case "command_execution":
			p.emitTool(agents.ToolUse{Name: "shell", Input: l.Item.Command, Output: truncate(l.Item.AggregatedOutput, 2000)})
		case "file_change":
			var paths []string
			for _, c := range l.Item.Changes {
				paths = append(paths, c.Kind+" "+c.Path)
			}
			p.emitTool(agents.ToolUse{Name: "edit", Input: strings.Join(paths, ", ")})
		case "mcp_tool_call":
			name := l.Item.Server + "." + l.Item.Tool
			if l.Item.Server == "companion" {
				name = l.Item.Tool // Companion's own tools render like the built-in engine's
			}
			p.emitTool(agents.ToolUse{Name: name, Input: compactJSON(l.Item.Arguments)})
		case "web_search":
			p.emitTool(agents.ToolUse{Name: "web_search", Input: l.Item.Query})
		case "error":
			p.errText = l.Item.Text
		}
	case "turn.completed":
		p.usage = l.Usage
	case "turn.failed":
		if l.Error != nil {
			p.errText = l.Error.Message
		}
	case "error":
		if l.Error != nil && l.Error.Message != "" {
			p.errText = l.Error.Message
		} else if l.Message != "" {
			p.errText = l.Message
		}
	case "":
		// Legacy msg-wrapped events.
		if l.Msg == nil {
			return
		}
		switch l.Msg.Type {
		case "session_configured":
			if l.Msg.SessionID != "" {
				p.sessionID = l.Msg.SessionID
			}
		case "agent_message_delta":
			p.text.WriteString(l.Msg.Delta)
			if p.onDelta != nil {
				p.onDelta(l.Msg.Delta)
			}
		case "agent_message":
			p.emitText(l.Msg.Message)
		case "error":
			p.errText = l.Msg.Message
		}
	}
}

func (p *codexParser) emitText(t string) {
	if t == "" {
		return
	}
	if p.text.Len() > 0 {
		t = "\n\n" + t
	}
	p.text.WriteString(t)
	if p.onDelta != nil {
		p.onDelta(t)
	}
}

func (p *codexParser) emitTool(tu agents.ToolUse) {
	if p.onTool != nil {
		p.onTool(tu)
	}
}
