//go:build !js && !windows

package agentrt

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"companion/core/agents"
)

// writeFakeCLI drops an executable shell script at dir/name that ignores its args, reads the
// prompt from stdin, and prints the given JSONL body (with \n newlines).
func writeFakeCLI(t *testing.T, dir, name, body string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	script := "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' \"$@\" >/dev/null\ncat <<'JSONL'\n" + body + "\nJSONL\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestClaudeRunnerParsesStreamJSON(t *testing.T) {
	dir := t.TempDir()
	body := strings.Join([]string{
		`{"type":"system","subtype":"init","session_id":"sess-1","model":"claude-sonnet"}`,
		`{"type":"stream_event","session_id":"sess-1","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}}`,
		`{"type":"stream_event","session_id":"sess-1","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}}`,
		`{"type":"assistant","session_id":"sess-1","message":{"role":"assistant","content":[{"type":"text","text":"Hello"},{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"/tmp/x"}}]}}`,
		`{"type":"user","session_id":"sess-1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":"file body"}]}}`,
		`not json at all`,
		`{"type":"result","subtype":"success","is_error":false,"result":"Hello","session_id":"sess-1","total_cost_usd":0.01,"usage":{"input_tokens":5}}`,
	}, "\n")
	path := writeFakeCLI(t, dir, "claude", body)

	r := &ClaudeRunner{Path: path}
	var deltas []string
	var tools []agents.ToolUse
	res, err := r.Run(context.Background(), agents.RunRequest{Prompt: "hi", Cwd: dir}, func(s string) { deltas = append(deltas, s) }, func(tu agents.ToolUse) { tools = append(tools, tu) })
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if res.SessionID != "sess-1" || res.Text != "Hello" {
		t.Errorf("result = %+v", res)
	}
	// Deltas come from stream events only; the whole-block assistant text is not echoed twice.
	if strings.Join(deltas, "") != "Hello" || len(deltas) != 2 {
		t.Errorf("deltas = %q", deltas)
	}
	if len(tools) != 1 || tools[0].Name != "Read" || !strings.Contains(tools[0].Input, "/tmp/x") {
		t.Errorf("tools = %+v", tools)
	}
	if res.Usage["input_tokens"] != float64(5) {
		t.Errorf("usage = %v", res.Usage)
	}
}

func TestClaudeRunnerWithoutPartialMessagesFallsBackToBlocks(t *testing.T) {
	dir := t.TempDir()
	body := strings.Join([]string{
		`{"type":"assistant","session_id":"s","message":{"content":[{"type":"text","text":"Whole"}]}}`,
		`{"type":"result","subtype":"success","result":"Whole","session_id":"s"}`,
	}, "\n")
	r := &ClaudeRunner{Path: writeFakeCLI(t, dir, "claude", body)}
	var deltas []string
	res, err := r.Run(context.Background(), agents.RunRequest{Prompt: "hi", Cwd: dir}, func(s string) { deltas = append(deltas, s) }, nil)
	if err != nil || res.Text != "Whole" || strings.Join(deltas, "") != "Whole" {
		t.Errorf("res=%+v deltas=%q err=%v", res, deltas, err)
	}
}

func TestClaudeRunnerSurfacesResultError(t *testing.T) {
	dir := t.TempDir()
	body := `{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Please run /login","session_id":"s"}`
	r := &ClaudeRunner{Path: writeFakeCLI(t, dir, "claude", body)}
	_, err := r.Run(context.Background(), agents.RunRequest{Prompt: "hi", Cwd: dir}, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "Please run /login") {
		t.Errorf("expected the CLI's message, got %v", err)
	}
}

func TestRunnerSurfacesStderrOnNonZeroExit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "claude")
	os.WriteFile(path, []byte("#!/bin/sh\ncat >/dev/null\necho 'Not logged in. Run claude login' >&2\nexit 1\n"), 0o755)
	r := &ClaudeRunner{Path: path}
	_, err := r.Run(context.Background(), agents.RunRequest{Prompt: "hi", Cwd: dir}, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "Not logged in") {
		t.Errorf("expected stderr in error, got %v", err)
	}
}

func TestRunnerCancelKillsProcess(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "claude")
	os.WriteFile(path, []byte("#!/bin/sh\ncat >/dev/null\nsleep 30\n"), 0o755)
	r := &ClaudeRunner{Path: path}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := r.Run(ctx, agents.RunRequest{Prompt: "hi", Cwd: dir}, nil, nil)
		done <- err
	}()
	time.Sleep(100 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err != context.Canceled {
			t.Errorf("err = %v, want context.Canceled", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancel did not stop the process")
	}
}

func TestCodexRunnerParsesItems(t *testing.T) {
	dir := t.TempDir()
	body := strings.Join([]string{
		`{"type":"thread.started","thread_id":"thr-9"}`,
		`{"type":"turn.started"}`,
		`{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"ls -la","aggregated_output":"a\nb","status":"completed"}}`,
		`{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"Two files."}}`,
		`{"type":"turn.completed","usage":{"input_tokens":12}}`,
	}, "\n")
	r := &CodexRunner{Path: writeFakeCLI(t, dir, "codex", body)}
	var deltas []string
	var tools []agents.ToolUse
	res, err := r.Run(context.Background(), agents.RunRequest{Prompt: "list", Cwd: dir}, func(s string) { deltas = append(deltas, s) }, func(tu agents.ToolUse) { tools = append(tools, tu) })
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if res.SessionID != "thr-9" || res.Text != "Two files." || strings.Join(deltas, "") != "Two files." {
		t.Errorf("res=%+v deltas=%q", res, deltas)
	}
	if len(tools) != 1 || tools[0].Name != "shell" || tools[0].Input != "ls -la" || tools[0].Output != "a\nb" {
		t.Errorf("tools = %+v", tools)
	}
}

func TestCodexRunnerLegacyShapeAndFailure(t *testing.T) {
	dir := t.TempDir()
	body := strings.Join([]string{
		`{"id":"0","msg":{"type":"session_configured","session_id":"legacy-1"}}`,
		`{"id":"1","msg":{"type":"agent_message_delta","delta":"Hi "}}`,
		`{"id":"1","msg":{"type":"agent_message_delta","delta":"there"}}`,
	}, "\n")
	r := &CodexRunner{Path: writeFakeCLI(t, dir, "codex", body)}
	res, err := r.Run(context.Background(), agents.RunRequest{Prompt: "x", Cwd: dir}, nil, nil)
	if err != nil || res.SessionID != "legacy-1" || res.Text != "Hi there" {
		t.Errorf("res=%+v err=%v", res, err)
	}

	r = &CodexRunner{Path: writeFakeCLI(t, dir, "codex2", `{"type":"turn.failed","error":{"message":"quota exceeded"}}`)}
	if _, err := r.Run(context.Background(), agents.RunRequest{Prompt: "x", Cwd: dir}, nil, nil); err == nil || !strings.Contains(err.Error(), "quota") {
		t.Errorf("expected failure surfaced, got %v", err)
	}
}

func TestDiscovererFindsBinariesAndServers(t *testing.T) {
	dir := t.TempDir()
	writeFakeCLI(t, dir, "claude", "")
	os.WriteFile(filepath.Join(dir, "claude"), []byte("#!/bin/sh\necho '2.1.0 (Claude Code)'\n"), 0o755)
	os.WriteFile(filepath.Join(dir, "codex"), []byte("#!/bin/sh\necho 'codex-cli 0.50.0'\n"), 0o755)

	ollama := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/version":
			json.NewEncoder(w).Encode(map[string]string{"version": "0.12.0"})
		case "/api/tags":
			w.Write([]byte(`{"models":[{"name":"qwen2.5:7b"},{"name":"llama3.1:8b"}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer ollama.Close()
	lm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			w.Write([]byte(`{"data":[{"id":"gemma-3"}]}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer lm.Close()

	// Empty PATH so only LookupDirs can find the fakes.
	t.Setenv("PATH", "")
	d := &Discoverer{LookupDirs: []string{dir}, OllamaURL: ollama.URL, LMStudioURL: lm.URL}
	found, err := d.Discover(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	byRuntime := map[string]agents.Discovered{}
	for _, f := range found {
		byRuntime[f.Runtime] = f
	}
	if len(found) != 4 {
		t.Fatalf("found %d: %+v", len(found), found)
	}
	if c := byRuntime["claude-cli"]; c.Path != filepath.Join(dir, "claude") || c.Version != "2.1.0" || c.Status != agents.StatusReady {
		t.Errorf("claude = %+v", c)
	}
	if c := byRuntime["codex-cli"]; c.Version != "0.50.0" {
		t.Errorf("codex = %+v", c)
	}
	if o := byRuntime["ollama"]; o.Version != "0.12.0" || len(o.Models) != 2 || o.Models[0] != "llama3.1:8b" || o.Path != ollama.URL+"/v1" {
		t.Errorf("ollama = %+v", o)
	}
	if l := byRuntime["lmstudio"]; len(l.Models) != 1 || l.Models[0] != "gemma-3" {
		t.Errorf("lmstudio = %+v", l)
	}
}

func TestDiscovererReportsNothingWhenAbsent(t *testing.T) {
	t.Setenv("PATH", "")
	dead := httptest.NewServer(http.NotFoundHandler())
	dead.Close()
	d := &Discoverer{LookupDirs: []string{t.TempDir()}, OllamaURL: dead.URL, LMStudioURL: dead.URL}
	found, err := d.Discover(context.Background())
	if err != nil || len(found) != 0 {
		t.Errorf("found = %+v, err = %v", found, err)
	}
}

func TestFactoryWorkDirAndRunnerFor(t *testing.T) {
	root := t.TempDir()
	f := NewFactory(root)
	dir, err := f.WorkDir("agent-1")
	if err != nil || dir != filepath.Join(root, "agents", "agent-1") {
		t.Fatalf("workdir = %q, %v", dir, err)
	}
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		t.Error("workdir not created")
	}
	if _, err := f.RunnerFor("claude-cli", filepath.Join(root, "missing")); err == nil {
		t.Error("expected error for a missing binary")
	}
	bin := writeFakeCLI(t, root, "codex", "")
	if r, err := f.RunnerFor("codex-cli", bin); err != nil || r == nil {
		t.Errorf("runner = %v, %v", r, err)
	}
	if _, err := f.RunnerFor("ollama", bin); err == nil {
		t.Error("ollama is not a CLI runtime")
	}
}
