// Package mcp exposes Companion's LLM tool registry (search_notes, list_tasks, create_note…) to
// external CLI agents as a Model Context Protocol server (PLAN-agents.md §4.5). Claude Code
// and Codex consume MCP natively, so this is how a CLI agent hosted by the desktop gets the
// same "ask my data" tools the built-in engine has, without teaching either CLI our tool JSON.
//
// Transport is MCP Streamable HTTP in its simplest form: the client POSTs a JSON-RPC 2.0
// message and gets a JSON response (no server-initiated SSE stream). The server binds to
// 127.0.0.1 only and authenticates each request with a per-agent bearer token, which also
// decides whether write tools are visible.
package mcp

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"companion/core/llm"
)

// ProtocolVersion is the MCP revision this server speaks.
const ProtocolVersion = "2025-06-18"

// Grant is what a bearer token authorizes: which agent it belongs to and whether write tools
// are allowed. Resolved per request so a permissions toggle applies to the next call.
type Grant struct {
	AgentID    string
	AllowWrite bool
}

// Authorizer resolves a bearer token to its grant; ok=false rejects the request.
type Authorizer func(token string) (Grant, bool)

// Server serves one registry to any number of CLI agents.
type Server struct {
	registry  *llm.Registry
	authorize Authorizer
	// onWrite, when set, is called after a write tool ran so the host can emit refresh events.
	onWrite func(tool string)

	mu     sync.Mutex
	ln     net.Listener
	srv    *http.Server
	tokens map[string]Grant // issued tokens (when the default authorizer is used)
}

// New builds a server over a registry. A nil authorizer uses the built-in token table
// (see IssueToken).
func New(registry *llm.Registry, authorize Authorizer) *Server {
	s := &Server{registry: registry, authorize: authorize, tokens: map[string]Grant{}}
	if s.authorize == nil {
		s.authorize = s.lookupToken
	}
	return s
}

// SetWriteHook registers a callback invoked after each successful write-tool call.
func (s *Server) SetWriteHook(fn func(tool string)) { s.onWrite = fn }

// IssueToken mints a bearer token bound to a grant (built-in authorizer only).
func (s *Server) IssueToken(g Grant) string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	tok := hex.EncodeToString(b)
	s.mu.Lock()
	s.tokens[tok] = g
	s.mu.Unlock()
	return tok
}

// UpdateGrant changes the grant behind every token issued for an agent (permissions toggle).
func (s *Server) UpdateGrant(agentID string, allowWrite bool) {
	s.mu.Lock()
	for tok, g := range s.tokens {
		if g.AgentID == agentID {
			g.AllowWrite = allowWrite
			s.tokens[tok] = g
		}
	}
	s.mu.Unlock()
}

func (s *Server) lookupToken(token string) (Grant, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g, ok := s.tokens[token]
	return g, ok
}

// Start listens on a random loopback port and serves until Stop. Returns the base URL of the
// MCP endpoint (…/mcp).
func (s *Server) Start() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ln != nil {
		return "http://" + s.ln.Addr().String() + "/mcp", nil
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	mux := http.NewServeMux()
	mux.Handle("/mcp", s)
	s.ln = ln
	s.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = s.srv.Serve(ln) }()
	return "http://" + ln.Addr().String() + "/mcp", nil
}

// Stop closes the listener.
func (s *Server) Stop() {
	s.mu.Lock()
	srv := s.srv
	s.srv, s.ln = nil, nil
	s.mu.Unlock()
	if srv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}
}

// --- JSON-RPC ---------------------------------------------------------------

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

const (
	codeParse         = -32700
	codeInvalidReq    = -32600
	codeMethodMissing = -32601
	codeInvalidParams = -32602
	codeInternal      = -32603
)

// ServeHTTP handles one Streamable HTTP request: POST with a JSON-RPC message (or batch).
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		// No server-initiated stream: GET is allowed to 405 per the spec.
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	token := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer"))
	grant, ok := s.authorize(token)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		http.Error(w, "read failed", http.StatusBadRequest)
		return
	}
	body = []byte(strings.TrimSpace(string(body)))
	if len(body) == 0 {
		http.Error(w, "empty body", http.StatusBadRequest)
		return
	}
	// A batch is a JSON array; a single message is an object.
	if body[0] == '[' {
		var batch []rpcRequest
		if err := json.Unmarshal(body, &batch); err != nil {
			writeRPC(w, http.StatusOK, rpcResponse{JSONRPC: "2.0", Error: &rpcError{codeParse, "parse error"}})
			return
		}
		var out []rpcResponse
		for _, req := range batch {
			if resp, ok := s.dispatch(r.Context(), grant, req); ok {
				out = append(out, resp)
			}
		}
		if len(out) == 0 {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		writeRPC(w, http.StatusOK, out)
		return
	}
	var req rpcRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeRPC(w, http.StatusOK, rpcResponse{JSONRPC: "2.0", Error: &rpcError{codeParse, "parse error"}})
		return
	}
	resp, ok := s.dispatch(r.Context(), grant, req)
	if !ok {
		w.WriteHeader(http.StatusAccepted) // a notification: no response body
		return
	}
	writeRPC(w, http.StatusOK, resp)
}

func writeRPC(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// dispatch runs one message. ok=false means it was a notification (no id) with nothing to say.
func (s *Server) dispatch(ctx context.Context, g Grant, req rpcRequest) (rpcResponse, bool) {
	isNotification := len(req.ID) == 0 || string(req.ID) == "null"
	reply := func(result any, err *rpcError) (rpcResponse, bool) {
		if isNotification {
			return rpcResponse{}, false
		}
		return rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: result, Error: err}, true
	}
	if req.JSONRPC != "2.0" {
		return reply(nil, &rpcError{codeInvalidReq, "jsonrpc must be \"2.0\""})
	}
	switch req.Method {
	case "initialize":
		return reply(map[string]any{
			"protocolVersion": ProtocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": "companion", "version": "1"},
			"instructions": "Tools over the user's Companion workspace: notes, tasks, projects and habits. " +
				"Call get_date before reasoning about relative dates. Load a note with get_note before quoting it. " +
				"Reference entities with the [[note:…]] / [[task:…]] wikilinks the tools return.",
		}, nil)
	case "notifications/initialized", "notifications/cancelled", "notifications/progress":
		return reply(nil, nil)
	case "ping":
		return reply(map[string]any{}, nil)
	case "tools/list":
		return reply(map[string]any{"tools": s.toolList(g)}, nil)
	case "tools/call":
		var params struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil || params.Name == "" {
			return reply(nil, &rpcError{codeInvalidParams, "name is required"})
		}
		if s.registry.IsWrite(params.Name) && !g.AllowWrite {
			return reply(toolError("this agent is read-only; enable \"Allow this agent to write\" in Companion › Settings › AI to use "+params.Name), nil)
		}
		args := params.Arguments
		if len(args) == 0 {
			args = json.RawMessage(`{}`)
		}
		out, err := s.registry.Invoke(ctx, params.Name, args)
		if err != nil {
			if strings.HasPrefix(err.Error(), "unknown tool") {
				return reply(nil, &rpcError{codeInvalidParams, err.Error()})
			}
			return reply(toolError(err.Error()), nil)
		}
		if s.onWrite != nil && s.registry.IsWrite(params.Name) {
			s.onWrite(params.Name)
		}
		return reply(map[string]any{
			"content": []map[string]any{{"type": "text", "text": out}},
			"isError": false,
		}, nil)
	default:
		return reply(nil, &rpcError{codeMethodMissing, "method not found: " + req.Method})
	}
}

func toolError(msg string) map[string]any {
	return map[string]any{"content": []map[string]any{{"type": "text", "text": msg}}, "isError": true}
}

// toolList renders the registry as MCP tool descriptors, hiding write tools from read-only grants.
func (s *Server) toolList(g Grant) []map[string]any {
	specs := s.registry.Specs()
	out := make([]map[string]any, 0, len(specs))
	for _, sp := range specs {
		if s.registry.IsWrite(sp.Name) && !g.AllowWrite {
			continue
		}
		schema := sp.Schema
		if len(schema) == 0 {
			schema = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		out = append(out, map[string]any{
			"name":        sp.Name,
			"description": sp.Description,
			"inputSchema": schema,
		})
	}
	return out
}

// ErrNotStarted is returned by URL when Start has not been called.
var ErrNotStarted = errors.New("mcp server not started")

// URL returns the endpoint URL once started.
func (s *Server) URL() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ln == nil {
		return "", ErrNotStarted
	}
	return "http://" + s.ln.Addr().String() + "/mcp", nil
}
