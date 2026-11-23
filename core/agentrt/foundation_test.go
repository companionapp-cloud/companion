//go:build !js && !windows

package agentrt

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"companion/core/agents"
	"companion/core/llm"
)

// fakeHelper writes a shell script that speaks companion-fm's protocol: check reports one model;
// run records the request, asks for one tool, records the reply, then answers.
func fakeHelper(t *testing.T, available bool) (path, dir string) {
	t.Helper()
	dir = t.TempDir()
	avail := "true"
	if !available {
		avail = `false,"reason":"Turn on Apple Intelligence"`
	}
	script := `#!/bin/sh
case "$1" in
check) echo '{"models":[{"id":"apple-on-device","label":"Apple Intelligence","available":` + avail + `}]}' ;;
run)
  read req; printf '%s' "$req" > "` + dir + `/req.json"
  echo '{"type":"tool_call","id":"call-1","name":"get_date","args":"{}"}'
  read res; printf '%s' "$res" > "` + dir + `/res.json"
  echo '{"type":"delta","text":"It is "}'
  echo '{"type":"delta","text":"Monday."}'
  echo '{"type":"done","text":"It is Monday."}' ;;
esac
`
	path = filepath.Join(dir, "companion-fm")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path, dir
}

func TestFoundationProviderProtocol(t *testing.T) {
	helper, dir := fakeHelper(t, true)
	fm := &FoundationModels{HelperPath: helper}
	p := fm.Provider(agents.FoundationOptions{}).(*FoundationProvider)

	models, err := p.ListModels(context.Background())
	if err != nil || len(models) != 1 || models[0] != "apple-on-device" {
		t.Fatalf("ListModels = %v, %v", models, err)
	}

	var streamed strings.Builder
	var invoked []llm.ToolCall
	msgs, err := p.ChatWithTools(context.Background(), llm.ChatRequest{
		System: "be brief",
		Messages: []llm.Message{
			{Role: llm.RoleUser, Text: "hi"},
			{Role: llm.RoleAssistant, ToolCalls: []llm.ToolCall{{ID: "x", Name: "get_date"}}},
			{Role: llm.RoleTool, ToolResults: []llm.ToolResult{{CallID: "x", Content: "Sunday"}}},
			{Role: llm.RoleAssistant, Text: "Hello!"},
			{Role: llm.RoleUser, Text: "what day is it?"},
		},
		Tools: []llm.ToolSpec{{Name: "get_date", Description: "today", Schema: json.RawMessage(`{"type":"object"}`)}},
	}, func(ctx context.Context, call llm.ToolCall) llm.ToolResult {
		invoked = append(invoked, call)
		return llm.ToolResult{Content: "Monday"}
	}, func(s string) { streamed.WriteString(s) })
	if err != nil {
		t.Fatalf("ChatWithTools: %v", err)
	}

	if len(invoked) != 1 || invoked[0].Name != "get_date" || invoked[0].ID != "call-1" {
		t.Errorf("tool not invoked as asked: %+v", invoked)
	}
	if streamed.String() != "It is Monday." {
		t.Errorf("streamed %q", streamed.String())
	}
	if len(msgs) != 3 || len(msgs[0].ToolCalls) != 1 || msgs[1].ToolResults[0].Content != "Monday" ||
		msgs[1].ToolResults[0].CallID != "call-1" || msgs[2].Text != "It is Monday." {
		t.Errorf("turn messages out of order: %+v", msgs)
	}

	var req fmRequest
	raw, _ := os.ReadFile(filepath.Join(dir, "req.json"))
	if err := json.Unmarshal(raw, &req); err != nil {
		t.Fatalf("request: %v (%s)", err, raw)
	}
	if req.Prompt != "what day is it?" || req.Model != "apple-on-device" || req.System != "be brief" || len(req.Tools) != 1 {
		t.Errorf("bad request: %+v", req)
	}
	// Text turns replay as history; tool traffic doesn't.
	if len(req.History) != 2 || req.History[0].Text != "hi" || req.History[1].Text != "Hello!" {
		t.Errorf("history = %+v", req.History)
	}
	var res map[string]any
	raw, _ = os.ReadFile(filepath.Join(dir, "res.json"))
	if json.Unmarshal(raw, &res) != nil || res["id"] != "call-1" || res["content"] != "Monday" || res["type"] != "tool_result" {
		t.Errorf("tool reply = %s", raw)
	}
}

func TestFoundationUnavailable(t *testing.T) {
	helper, _ := fakeHelper(t, false)
	fm := &FoundationModels{HelperPath: helper}
	found := fm.Discover(context.Background())
	if found == nil || found.Status != "not_running" || found.Detail != "Turn on Apple Intelligence" || len(found.Models) != 0 {
		t.Errorf("discover = %+v", found)
	}
	if _, err := fm.Provider(agents.FoundationOptions{}).(*FoundationProvider).ListModels(context.Background()); err == nil || !strings.Contains(err.Error(), "Turn on") {
		t.Errorf("ListModels should explain why nothing can run, got %v", err)
	}
	var nilFM *FoundationModels
	if nilFM.Discover(context.Background()) != nil {
		t.Error("no helper should mean no card")
	}
}

func TestFoundationHistoryBudget(t *testing.T) {
	long := strings.Repeat("x", foundationHistoryBudget)
	req, err := foundationRequest(llm.ChatRequest{Messages: []llm.Message{
		{Role: llm.RoleUser, Text: "old"},
		{Role: llm.RoleAssistant, Text: long},
		{Role: llm.RoleUser, Text: "recent"},
		{Role: llm.RoleAssistant, Text: "ok"},
		{Role: llm.RoleUser, Text: "now"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(req.History) != 2 || req.History[0].Text != "recent" || req.History[1].Text != "ok" {
		t.Errorf("history past the budget should drop the oldest turns: %d turns", len(req.History))
	}
	if _, err := foundationRequest(llm.ChatRequest{}); err == nil {
		t.Error("no user message should be an error")
	}
}

// TestFoundationLive runs the real helper against this Mac's model. Opt in with
// COMPANION_FM_HELPER=/path/to/companion-fm (built by `make desktop-fm`).
func TestFoundationLive(t *testing.T) {
	helper := os.Getenv("COMPANION_FM_HELPER")
	if helper == "" {
		t.Skip("set COMPANION_FM_HELPER to run against Apple Intelligence")
	}
	fm := &FoundationModels{HelperPath: helper}
	models, err := fm.Provider(agents.FoundationOptions{}).(*FoundationProvider).ListModels(context.Background())
	if err != nil {
		t.Skipf("Apple Intelligence unavailable: %v", err)
	}
	engine := &llm.Engine{Provider: fm.Provider(agents.FoundationOptions{}), Model: models[0], System: "You answer using tools.", Registry: llm.NewRegistry()}
	engine.Registry.Add(llm.Tool{
		Spec: llm.ToolSpec{Name: "get_date", Description: "Returns today's date. Call it for any question about the date.",
			Schema: json.RawMessage(`{"type":"object","properties":{}}`)},
		Handler: func(context.Context, json.RawMessage) (string, error) { return "Monday, 23 November 2026", nil },
	})
	var tools int
	out, err := engine.Run(context.Background(), []llm.Message{{Role: llm.RoleUser, Text: "What's today's date?"}}, nil,
		func(llm.ToolEvent) { tools++ })
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	final := out[len(out)-1].Text
	t.Logf("tools=%d reply=%q", tools, final)
	if tools == 0 || !strings.Contains(final, "23") {
		t.Errorf("expected the model to call get_date and use it")
	}
}

func TestShortenTools(t *testing.T) {
	in := []llm.ToolSpec{
		{Name: "create_task", Description: "Create a single task. Long explanation follows.", Schema: json.RawMessage(`{"type":"object","properties":{"dueAt":{"type":"string","description":"Optional RFC3339 deadline: when it must be done. More."},"status":{"type":"string","enum":["open","done"]}},"required":["title"]}`)},
		{Name: "get_page", Description: "Read a page. It returns its body.", Schema: json.RawMessage(`{"type":"object"}`)},
	}
	out := shortenTools(in, map[string]string{"create_task": "add a task"})
	if out[0].Description != "add a task" || out[1].Description != "Read a page" {
		t.Errorf("descriptions: %q, %q", out[0].Description, out[1].Description)
	}
	var schema map[string]any
	json.Unmarshal(out[0].Schema, &schema)
	props := schema["properties"].(map[string]any)
	if d := props["dueAt"].(map[string]any)["description"]; d != "RFC3339 deadline" {
		t.Errorf("argument description = %q", d)
	}
	if e := props["status"].(map[string]any)["enum"].([]any); len(e) != 2 || schema["required"].([]any)[0] != "title" {
		t.Error("schema structure must survive")
	}
	if in[0].Description == "add a task" {
		t.Error("the caller's specs must not change")
	}
}
