// Package agents holds the platform-neutral types for local AI agents (PLAN-agents.md): what
// discovery reports and how a CLI agent's turn is driven. It depends only on the standard
// library so the bridge (and the wasm/gomobile builds) can name these types while the actual
// process-spawning implementation lives in core/agentrt behind a shell-injected seam.
package agents

import (
	"context"
	"errors"
)

// Status of a discovered agent.
const (
	StatusReady              = "ready"
	StatusNeedsLogin         = "needs_login"
	StatusNotRunning         = "not_running"
	StatusUnsupportedVersion = "unsupported_version"
)

// Discovered is one AI tool found on the hosting machine (PLAN-agents.md §3). It is
// ephemeral: "Install" turns it into an agent row hosted by this device.
type Discovered struct {
	// Runtime is the domain.Runtime string (kept as a string here to avoid a domain import).
	Runtime string `json:"runtime"`
	Name    string `json:"name"`
	// Path is the binary path (CLI runtimes) or base URL (HTTP runtimes).
	Path    string `json:"path"`
	Version string `json:"version,omitempty"`
	Status  string `json:"status"`
	// Detail is a short human hint for non-ready states ("Start Ollama to use it").
	Detail string `json:"detail,omitempty"`
	// Models is what an HTTP runtime reports right now (Ollama tags, LM Studio models).
	Models []string `json:"models,omitempty"`
	// InstalledAgentID is set when an agent row on this device already points at this tool.
	InstalledAgentID *string `json:"installedAgentId,omitempty"`
}

// ErrSessionExpired is returned (wrapped) by a Runner when RunRequest.SessionID names a
// conversation the CLI no longer has — pruned, expired, or created on another machine. The
// caller should start a fresh session and carry the history over itself.
var ErrSessionExpired = errors.New("agent session expired")

// Discoverer scans the local machine for supported AI tools.
type Discoverer interface {
	Discover(ctx context.Context) ([]Discovered, error)
}

// RunRequest is one user turn handed to a CLI runtime.
type RunRequest struct {
	// Prompt is the user's message for this turn.
	Prompt string
	// Model, when set, overrides the CLI's default model.
	Model string
	// SessionID resumes an earlier conversation with the CLI; "" starts a new one.
	SessionID string
	// AllowSystem permits file edits / shell commands on the host; false keeps the run
	// read-only on the filesystem. Companion's own write tools are gated separately by the
	// MCP grant, not here.
	AllowSystem bool
	// Cwd is the working directory the process runs in (a per-agent scratch dir).
	Cwd string
	// MCP, when set, is the Companion tools endpoint the CLI should connect to (PLAN-agents.md
	// §4.5). Each runner renders it in its CLI's own config shape.
	MCP *MCPEndpoint
}

// MCPEndpoint is a Streamable-HTTP MCP server plus the bearer token that authorizes this agent.
type MCPEndpoint struct {
	URL   string
	Token string
}

// RunResult is what a completed CLI turn produced.
type RunResult struct {
	// SessionID is the CLI's conversation id to resume next turn.
	SessionID string
	// Text is the final assistant message (also streamed via onDelta).
	Text string
	// Usage is whatever the CLI reported (cost, tokens) for display; may be nil.
	Usage map[string]any
}

// ToolUse reports one tool/command the CLI ran during a turn.
type ToolUse struct {
	Name  string `json:"name"`
	Input string `json:"input"`
	// Output is the tool's result when the CLI reports one (may be empty).
	Output string `json:"output,omitempty"`
}

// Runner drives a CLI agent (Claude Code, Codex). One Run is one user turn: the process is
// started, streams its JSONL, and exits.
type Runner interface {
	Run(ctx context.Context, req RunRequest, onDelta func(text string), onTool func(ToolUse)) (*RunResult, error)
	// ListModels returns models the CLI can be asked to use. CLIs don't enumerate them, so
	// implementations return a curated list plus whatever the settings pin.
	ListModels(ctx context.Context) ([]string, error)
}

// RunnerFactory resolves a Runner for an installed agent. The bridge holds one, injected by the
// desktop shell; other shells leave it nil and route hosted agents through the relay.
type RunnerFactory interface {
	// RunnerFor returns a runner for the given runtime and binary path.
	RunnerFor(runtime, binaryPath string) (Runner, error)
	// WorkDir returns (creating if needed) the scratch directory for an agent id.
	WorkDir(agentID string) (string, error)
}
