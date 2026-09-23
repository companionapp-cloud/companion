package syncserver

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"companion/core/agents"
)

// streamingRunner stands in for Claude Code on the desktop: it streams its answer in two chunks.
// A grammar prompt gets the JSON that task asks for.
type streamingRunner struct{}

func (streamingRunner) ListModels(context.Context) ([]string, error) { return []string{"default"}, nil }

func (streamingRunner) Run(_ context.Context, req agents.RunRequest, onDelta func(string), _ func(agents.ToolUse)) (*agents.RunResult, error) {
	text := "A short summary."
	if strings.Contains(req.Prompt, "Proofread") {
		text = `{"corrected":"The cat.","issues":[{"original":"teh","suggestion":"The","explanation":"Spelling"}]}`
	}
	onDelta(text[:len(text)/2])
	onDelta(text[len(text)/2:])
	return &agents.RunResult{Text: text}, nil
}

type streamingRunners struct{ dir string }

func (r streamingRunners) RunnerFor(string, string) (agents.Runner, error) { return streamingRunner{}, nil }
func (r streamingRunners) WorkDir(string) (string, error)                  { return r.dir, nil }

// TestRelayRunsEditorAssistOnHostedAgent: a phone whose only agent is the desktop's Claude Code
// gets the editor assists (ai.status enabled), runs one through the relay, and receives the
// streamed text and the final result as its own ai.* events for its run id.
func TestRelayRunsEditorAssistOnHostedAgent(t *testing.T) {
	ts := newServer(t)
	tok := register(t, ts.URL, "assist@x.co", "password")

	desktop, _ := newCore(t, "macos", true)
	desktop.SetAgentRunners(streamingRunners{dir: t.TempDir()})
	phone, phoneLog := newCore(t, "ios", false)
	invoke(t, desktop, "sync.configure", map[string]any{"baseUrl": ts.URL, "token": tok})
	invoke(t, phone, "sync.configure", map[string]any{"baseUrl": ts.URL, "token": tok})
	t.Cleanup(func() { desktop.Invoke("sync.disconnect", nil) })

	invoke(t, desktop, "agents.install", map[string]any{"runtime": "claude-cli", "name": "Claude Code", "binaryPath": "/usr/local/bin/claude", "isDefault": true})
	invoke(t, desktop, "sync.run", nil)

	deadline := time.Now().Add(5 * time.Second)
	for {
		invoke(t, phone, "sync.run", nil)
		time.Sleep(100 * time.Millisecond)
		var st struct {
			Enabled bool   `json:"enabled"`
			Reason  string `json:"reason"`
		}
		json.Unmarshal(invoke(t, phone, "ai.status", nil), &st)
		if st.Enabled {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("assists never enabled on the phone: %+v", st)
		}
	}

	wait := func(runID string) map[string]any {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			phoneLog.mu.Lock()
			for _, name := range []string{"ai.done", "ai.error"} {
				for _, p := range phoneLog.events[name] {
					var e map[string]any
					json.Unmarshal(p, &e)
					if e["runId"] == runID {
						phoneLog.mu.Unlock()
						if name == "ai.error" {
							t.Fatalf("run %s failed: %v", runID, e["error"])
						}
						return e
					}
				}
			}
			phoneLog.mu.Unlock()
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("run %s never finished", runID)
		return nil
	}

	var ack struct {
		Remote bool `json:"remote"`
	}
	json.Unmarshal(invoke(t, phone, "ai.run", map[string]any{"runId": "p1", "task": "summarize", "text": "A long note."}), &ack)
	if !ack.Remote {
		t.Fatal("the run should go through the relay")
	}
	done := wait("p1")
	if done["text"] != "A short summary." || done["task"] != "summarize" {
		t.Errorf("done = %+v", done)
	}
	var streamed strings.Builder
	phoneLog.mu.Lock()
	for _, p := range phoneLog.events["ai.delta"] {
		var e struct {
			RunID string `json:"runId"`
			Text  string `json:"text"`
		}
		json.Unmarshal(p, &e)
		if e.RunID == "p1" {
			streamed.WriteString(e.Text)
		}
	}
	phoneLog.mu.Unlock()
	if streamed.String() != "A short summary." {
		t.Errorf("streamed = %q", streamed.String())
	}

	// A structured task's parsed result survives the trip.
	invoke(t, phone, "ai.run", map[string]any{"runId": "p2", "task": "grammar", "text": "teh cat."})
	res, _ := wait("p2")["result"].(map[string]any)
	if res["corrected"] != "The cat." {
		t.Errorf("grammar result = %+v", res)
	}
}
