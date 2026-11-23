package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sync"

	"companion/core/mcp"
)

// Terminal agents: Claude Code or Codex sessions the user runs in their own terminal reach this
// workspace through `companion mcp`, which relays stdio MCP to a loopback server here (see
// core/mcp/terminal.go). It is a server of its own, apart from the one hosted CLI agents use:
// one token, one write switch, and no render_* tools, which draw previews in Companion's chat
// and would tell a terminal agent the user can see something they can't.

// terminalAgentID is the grant's agent id; there is one terminal grant, not one per session.
const terminalAgentID = "terminal"

// terminalInstructions replaces the chat-oriented server guidance for terminal sessions.
const terminalInstructions = "Tools over the user's Companion workspace: notes, tasks, projects, habits, calendar events and canvases. " +
	"Call get_date before reasoning about relative dates. Find the user's own content with search_notes, list_tasks, list_projects and list_events; " +
	"load a note with get_note before quoting it. The user reads your reply in a terminal, so quote or summarize what matters " +
	"and give titles rather than bare ids. Tool results reference entities as [[note:…]] / [[task:…]] wikilinks; " +
	"use the same form when writing links into note content. Ask before creating or changing many items at once."

type terminalState struct {
	mu      sync.Mutex
	path    string // the TerminalConfigFile; empty when this shell can't host terminal agents
	command string // how a terminal runs the proxy: "companion", or the binary's absolute path
	cfg     mcp.TerminalConfig
	srv     *mcp.Server
}

// terminalAgentsView is what Settings › AI shows.
type terminalAgentsView struct {
	Available  bool   `json:"available"`
	Enabled    bool   `json:"enabled"`
	AllowWrite bool   `json:"allowWrite"`
	Command    string `json:"command"`
	Running    bool   `json:"running"`
}

// SetTerminalAgents lets terminal agents in (desktop only): dir holds the config file beside the
// database, command is what a terminal runs to start the proxy. Restores the server if the user
// left it switched on.
func (c *Core) SetTerminalAgents(dir, command string) error {
	t := &c.terminal
	t.mu.Lock()
	defer t.mu.Unlock()
	t.path = filepath.Join(dir, mcp.TerminalConfigFile)
	t.command = command
	cfg, err := mcp.ReadTerminalConfig(t.path)
	if err != nil {
		return err
	}
	t.cfg = mcp.TerminalConfig{Enabled: cfg.Enabled, AllowWrite: cfg.AllowWrite}
	return c.applyTerminalLocked()
}

// StopTerminalAgents closes the server, leaving the settings for the next launch.
func (c *Core) StopTerminalAgents() {
	t := &c.terminal
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.srv != nil {
		t.srv.Stop()
		t.srv = nil
	}
}

// applyTerminalLocked starts or stops the server to match t.cfg and publishes the result.
func (c *Core) applyTerminalLocked() error {
	t := &c.terminal
	switch {
	case t.cfg.Enabled && t.srv == nil:
		srv := mcp.New(c.toolRegistry().Without("render_note", "render_task", "render_event", "render_canvas", "render_graph"), nil)
		srv.SetInstructions(terminalInstructions)
		srv.SetWriteHook(func(string) { c.emitDataChanged("", "") })
		url, err := srv.Start()
		if err != nil {
			return fmt.Errorf("start terminal agents server: %w", err)
		}
		t.srv = srv
		t.cfg.URL = url
		t.cfg.Token = srv.IssueToken(mcp.Grant{AgentID: terminalAgentID, AllowWrite: t.cfg.AllowWrite})
	case t.cfg.Enabled:
		t.srv.UpdateGrant(terminalAgentID, t.cfg.AllowWrite)
	case t.srv != nil:
		t.srv.Stop()
		t.srv = nil
		t.cfg.URL, t.cfg.Token = "", ""
	}
	return mcp.WriteTerminalConfig(t.path, t.cfg)
}

func (c *Core) terminalViewLocked() terminalAgentsView {
	t := &c.terminal
	return terminalAgentsView{
		Available: t.path != "", Enabled: t.cfg.Enabled, AllowWrite: t.cfg.AllowWrite,
		Command: t.command, Running: t.srv != nil,
	}
}

func (c *Core) terminalAgentsGet() ([]byte, error) {
	c.terminal.mu.Lock()
	defer c.terminal.mu.Unlock()
	return json.Marshal(c.terminalViewLocked())
}

func (c *Core) terminalAgentsUpdate(payload []byte) ([]byte, error) {
	var args struct {
		Enabled    *bool `json:"enabled"`
		AllowWrite *bool `json:"allowWrite"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	t := &c.terminal
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.path == "" {
		return nil, errors.New("terminal agents need the Companion desktop app")
	}
	if args.Enabled != nil {
		t.cfg.Enabled = *args.Enabled
	}
	if args.AllowWrite != nil {
		t.cfg.AllowWrite = *args.AllowWrite
	}
	if err := c.applyTerminalLocked(); err != nil {
		return nil, err
	}
	return json.Marshal(c.terminalViewLocked())
}
