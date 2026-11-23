//go:build !js

package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"companion/core/mcp"
)

// proxyRound sends lines through a `companion mcp` proxy and returns the replies by id.
func proxyRound(t *testing.T, cfgPath string, lines ...string) map[string]map[string]any {
	t.Helper()
	var out bytes.Buffer
	p := &mcp.Proxy{ConfigPath: cfgPath}
	if err := p.Serve(context.Background(), strings.NewReader(strings.Join(lines, "\n")+"\n"), &out); err != nil {
		t.Fatal(err)
	}
	replies := map[string]map[string]any{}
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("reply %q: %v", line, err)
		}
		id, _ := json.Marshal(m["id"])
		replies[string(id)] = m
	}
	return replies
}

func toolNames(reply map[string]any) map[string]bool {
	names := map[string]bool{}
	result, _ := reply["result"].(map[string]any)
	tools, _ := result["tools"].([]any)
	for _, tl := range tools {
		names[tl.(map[string]any)["name"].(string)] = true
	}
	return names
}

func TestTerminalAgentsThroughProxy(t *testing.T) {
	c, h := newTestCore(t)
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, mcp.TerminalConfigFile)
	if err := c.SetTerminalAgents(dir, "companion"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.StopTerminalAgents)

	view := call[terminalAgentsView](t, c, "terminalAgents.get", "")
	if !view.Available || view.Enabled || view.Running || view.Command != "companion" {
		t.Fatalf("fresh view = %+v", view)
	}

	// Switched off: the proxy answers for the app, pointing at the setting.
	off := proxyRound(t, cfgPath, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	if msg, _ := off["1"]["error"].(map[string]any)["message"].(string); !strings.Contains(msg, "Terminal agents") {
		t.Fatalf("switched-off reply = %v", off["1"])
	}

	view = call[terminalAgentsView](t, c, "terminalAgents.update", `{"enabled":true}`)
	if !view.Enabled || !view.Running || view.AllowWrite {
		t.Fatalf("enabled view = %+v", view)
	}
	if info, err := os.Stat(cfgPath); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("config file must be private: %v %v", info, err)
	}

	// Read-only: no write tools listed, a write call is refused, and no render_* tools at all.
	got := proxyRound(t, cfgPath,
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create_note","arguments":{"title":"From the terminal"}}}`,
	)
	if len(got) != 3 {
		t.Fatalf("want replies to the 3 requests and none to the notification, got %v", got)
	}
	instr, _ := got["1"]["result"].(map[string]any)["instructions"].(string)
	if !strings.Contains(instr, "terminal") || strings.Contains(instr, "render_") {
		t.Errorf("terminal sessions should get terminal guidance: %q", instr)
	}
	names := toolNames(got["2"])
	if !names["search_notes"] || names["create_note"] || names["render_note"] || names["render_graph"] {
		t.Errorf("read-only tool list = %v", names)
	}
	if res, _ := got["3"]["result"].(map[string]any); res["isError"] != true {
		t.Errorf("write on a read-only grant should fail: %v", got["3"])
	}

	// Allowing writes applies to the next message, with the same token.
	call[terminalAgentsView](t, c, "terminalAgents.update", `{"allowWrite":true}`)
	got = proxyRound(t, cfgPath,
		`{"jsonrpc":"2.0","id":4,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"create_note","arguments":{"title":"From the terminal"}}}`,
	)
	if names := toolNames(got["4"]); !names["create_note"] || names["render_task"] {
		t.Errorf("read-write tool list = %v", names)
	}
	if res, _ := got["5"]["result"].(map[string]any); res["isError"] != false {
		t.Fatalf("create_note = %v", got["5"])
	}
	notes, err := c.store.Notes.List()
	if err != nil || len(notes) != 1 || notes[0].Title != "From the terminal" {
		t.Fatalf("notes after create = %+v %v", notes, err)
	}
	if h.count(dataChangedEvent) == 0 {
		t.Error("a terminal write should refresh open views")
	}

	// A relaunch keeps the settings and publishes a new endpoint the proxy picks up.
	before, _ := mcp.ReadTerminalConfig(cfgPath)
	c.StopTerminalAgents()
	c2, _ := newTestCore(t)
	if err := c2.SetTerminalAgents(dir, "companion"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c2.StopTerminalAgents)
	after, _ := mcp.ReadTerminalConfig(cfgPath)
	if !after.Enabled || !after.AllowWrite || after.Token == before.Token {
		t.Fatalf("relaunch config = %+v (before %+v)", after, before)
	}
	if got := proxyRound(t, cfgPath, `{"jsonrpc":"2.0","id":6,"method":"ping"}`); got["6"]["error"] != nil {
		t.Fatalf("ping after relaunch = %v", got["6"])
	}

	// Switching off drops the endpoint.
	call[terminalAgentsView](t, c2, "terminalAgents.update", `{"enabled":false}`)
	if cfg, _ := mcp.ReadTerminalConfig(cfgPath); cfg.Token != "" || cfg.URL != "" || !cfg.AllowWrite {
		t.Fatalf("switched-off config = %+v", cfg)
	}
}

func TestTerminalAgentsUnavailableWithoutDesktop(t *testing.T) {
	c, _ := newTestCore(t)
	if view := call[terminalAgentsView](t, c, "terminalAgents.get", ""); view.Available {
		t.Fatalf("view = %+v", view)
	}
	if _, err := c.Invoke("terminalAgents.update", []byte(`{"enabled":true}`)); err == nil {
		t.Fatal("enabling without a desktop shell should fail")
	}
}

// Terminal programs get reads, note and task writes only when allowed, and nothing else.
func TestTerminalInvokeAllowlist(t *testing.T) {
	c, _ := newTestCore(t)
	dir := t.TempDir()
	if err := c.SetTerminalAgents(dir, "companion"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.StopTerminalAgents)
	call[terminalAgentsView](t, c, "terminalAgents.update", `{"enabled":true}`)
	cfg, _ := mcp.ReadTerminalConfig(filepath.Join(dir, mcp.TerminalConfigFile))
	base := strings.TrimSuffix(cfg.URL, "/mcp")

	invoke := func(token, method, payload string) (int, string) {
		t.Helper()
		req, _ := http.NewRequest(http.MethodPost, base+"/invoke", strings.NewReader(`{"method":"`+method+`","payload":`+payload+`}`))
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(body)
	}

	if code, _ := invoke("wrong", "notes.list", "null"); code != http.StatusUnauthorized {
		t.Errorf("bad token: %d", code)
	}
	if code, body := invoke(cfg.Token, "notes.list", "null"); code != http.StatusOK || body != "[]" {
		t.Errorf("read: %d %s", code, body)
	}
	if code, body := invoke(cfg.Token, "notes.create", `{"title":"x"}`); code != http.StatusForbidden || !strings.Contains(body, "read-only") {
		t.Errorf("write while read-only: %d %s", code, body)
	}
	call[terminalAgentsView](t, c, "terminalAgents.update", `{"allowWrite":true}`)
	code, body := invoke(cfg.Token, "notes.create", `{"title":"From the TUI"}`)
	if code != http.StatusOK || !strings.Contains(body, "From the TUI") {
		t.Fatalf("write: %d %s", code, body)
	}
	var created struct{ ID string }
	_ = json.Unmarshal([]byte(body), &created)
	// Deletes stay out of reach even with writes on.
	if code, _ := invoke(cfg.Token, "notes.delete", `{"id":"`+created.ID+`"}`); code != http.StatusForbidden {
		t.Errorf("delete: %d", code)
	}
	if code, _ := invoke(cfg.Token, "sync.now", "null"); code != http.StatusForbidden {
		t.Errorf("sync: %d", code)
	}
	if notes, _ := c.store.Notes.List(); len(notes) != 1 {
		t.Errorf("notes = %d, want 1", len(notes))
	}
}
