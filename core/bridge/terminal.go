package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
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
	"load a note with get_note before quoting it. Handwriting (inkGroups on get_note or get_page) is read with read_ink and turned into typed text with convert_ink_to_text. The user reads your reply in a terminal, so quote or summarize what matters " +
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
		srv.Mount("/invoke", c.serveTerminalInvoke)
		srv.Mount("/events", c.serveTerminalEvents)
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

// Terminal programs (`companion tui`, `companion new`) call the core directly through /invoke,
// but only these methods: reads, plus creating and editing notes and tasks when the user allowed
// writes. Deletes, sync, encryption, agents and secrets stay out of reach of a terminal.
var terminalReads = map[string]bool{
	"core.version": true, "dates.parse": true,
	"notes.list": true, "notes.get": true,
	"tasks.list": true, "tasks.get": true,
	"projects.list": true, "projects.members": true, "projects.forEntity": true,
	"lists.list": true, "lists.items": true,
	"calendar.range": true, "calendar.events.get": true, "calendar.feeds.list": true,
	"canvases.list": true, "canvases.get": true,
	"graph.full": true, "graph.neighborhood": true, "graph.backlinks": true,
	"graph.search": true, "graph.lookup": true,
}

var terminalWrites = map[string]bool{
	"notes.create": true, "notes.update": true,
	"tasks.create": true, "tasks.update": true,
}

// terminalEvents are the refresh hints /events forwards.
var terminalEvents = map[string]bool{
	dataChangedEvent: true, notesChangedEvent: true, tasksChangedEvent: true,
	calendarChangedEvent: true, canvasesChangedEvent: true, listsChangedEvent: true,
}

// serveTerminalInvoke handles POST /invoke {"method", "payload"}, like the desktop webview's.
func (c *Core) serveTerminalInvoke(g mcp.Grant, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Method  string          `json:"method"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<20)).Decode(&req); err != nil {
		writeTerminalError(w, http.StatusBadRequest, "bad request: "+err.Error())
		return
	}
	switch {
	case terminalReads[req.Method]:
	case terminalWrites[req.Method] && g.AllowWrite:
	case terminalWrites[req.Method]:
		writeTerminalError(w, http.StatusForbidden, "terminal agents are read-only; turn on write tools in Companion › Settings › AI › Terminal agents")
		return
	default:
		writeTerminalError(w, http.StatusForbidden, req.Method+" isn't available to terminal programs")
		return
	}
	out, err := c.Invoke(req.Method, req.Payload)
	if err != nil {
		writeTerminalError(w, http.StatusBadRequest, err.Error())
		return
	}
	if out == nil {
		out = []byte("null")
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(out)
}

func writeTerminalError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// serveTerminalEvents streams refresh hints as Server-Sent Events until the client goes away.
func (c *Core) serveTerminalEvents(_ mcp.Grant, w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	ch := make(chan string, 16)
	stop := c.tapEvents(func(name string, _ []byte) {
		if !terminalEvents[name] {
			return
		}
		select {
		case ch <- name:
		default: // a slow reader misses a hint, not the data
		}
	})
	defer stop()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	for {
		select {
		case <-r.Context().Done():
			return
		case name := <-ch:
			fmt.Fprintf(w, "event: %s\ndata: {}\n\n", name)
			flusher.Flush()
		}
	}
}
