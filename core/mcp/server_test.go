//go:build !js

package mcp

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"companion/core/domain"
	"companion/core/llm"
	"companion/core/store"
)

func rpc(t *testing.T, url, token string, body string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func TestMCPServerToolsAndGating(t *testing.T) {
	st, err := store.Open(":memory:", domain.SystemClock{})
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if _, err := st.Notes.Create(store.CreateNoteInput{Title: "Groceries", ContentMD: "milk and eggs"}); err != nil {
		t.Fatal(err)
	}
	s := New(llm.NewStoreRegistry(st), nil)
	writes := 0
	s.SetWriteHook(func(string) { writes++ })
	url, err := s.Start()
	if err != nil {
		t.Fatal(err)
	}
	defer s.Stop()
	if !strings.HasPrefix(url, "http://127.0.0.1:") {
		t.Fatalf("url = %q", url)
	}
	ro := s.IssueToken(Grant{AgentID: "a", AllowWrite: false})
	rw := s.IssueToken(Grant{AgentID: "b", AllowWrite: true})

	// Unauthenticated and wrong-method requests are refused.
	if code, _ := rpc(t, url, "", `{"jsonrpc":"2.0","id":1,"method":"ping"}`); code != http.StatusUnauthorized {
		t.Errorf("no token status = %d", code)
	}
	if res, _ := http.Get(url); res.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("GET status = %d", res.StatusCode)
	}

	// initialize + notification.
	code, init := rpc(t, url, ro, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}`)
	if code != 200 || init["result"].(map[string]any)["protocolVersion"] != ProtocolVersion {
		t.Fatalf("initialize = %d %v", code, init)
	}
	req, _ := http.NewRequest(http.MethodPost, url, strings.NewReader(`{"jsonrpc":"2.0","method":"notifications/initialized"}`))
	req.Header.Set("Authorization", "Bearer "+ro)
	res, _ := http.DefaultClient.Do(req)
	res.Body.Close()
	if res.StatusCode != http.StatusAccepted {
		t.Errorf("notification status = %d, want 202", res.StatusCode)
	}

	// Read-only grant: no write tools listed, write call refused as a tool error.
	_, list := rpc(t, url, ro, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	names := toolNames(list)
	if !names["search_notes"] || names["create_note"] {
		t.Errorf("read-only tool list = %v", names)
	}
	_, denied := rpc(t, url, ro, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"create_note","arguments":{"title":"x"}}}`)
	if r := denied["result"].(map[string]any); r["isError"] != true {
		t.Errorf("write on read-only grant should be a tool error: %v", denied)
	}

	// Read call works and hits the store.
	_, found := rpc(t, url, ro, `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"search_notes","arguments":{"query":"milk"}}}`)
	text := found["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, "Groceries") {
		t.Errorf("search result = %s", text)
	}

	// Write grant: create_note listed, works, fires the hook.
	_, list = rpc(t, url, rw, `{"jsonrpc":"2.0","id":5,"method":"tools/list"}`)
	if !toolNames(list)["create_note"] {
		t.Error("write grant should list create_note")
	}
	_, created := rpc(t, url, rw, `{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"create_note","arguments":{"title":"From MCP","contentMd":"hi"}}}`)
	if r := created["result"].(map[string]any); r["isError"] != false {
		t.Errorf("create_note failed: %v", created)
	}
	if writes != 1 {
		t.Errorf("write hook fired %d times", writes)
	}
	notes, _ := st.Notes.List()
	if len(notes) != 2 {
		t.Errorf("expected the MCP write to land in the store, have %d notes", len(notes))
	}

	// Toggling the grant applies to existing tokens.
	s.UpdateGrant("b", false)
	_, list = rpc(t, url, rw, `{"jsonrpc":"2.0","id":7,"method":"tools/list"}`)
	if toolNames(list)["create_note"] {
		t.Error("grant update should hide write tools")
	}

	// Unknown method / tool.
	_, missing := rpc(t, url, ro, `{"jsonrpc":"2.0","id":8,"method":"resources/list"}`)
	if missing["error"] == nil {
		t.Errorf("unknown method should error: %v", missing)
	}
	_, unknownTool := rpc(t, url, ro, `{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"nope"}}`)
	if unknownTool["error"] == nil {
		t.Errorf("unknown tool should be an rpc error: %v", unknownTool)
	}
}

func toolNames(list map[string]any) map[string]bool {
	out := map[string]bool{}
	res, _ := list["result"].(map[string]any)
	tools, _ := res["tools"].([]any)
	for _, tl := range tools {
		out[tl.(map[string]any)["name"].(string)] = true
	}
	return out
}
