//go:build !js && !windows

package syncserver

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"companion/core/agentrt"
)

// scriptedHelper writes a stand-in for companion-fm that answers one turn by creating a task,
// so the relay path can be checked anywhere. COMPANION_FM_HELPER swaps in the real helper.
func scriptedHelper(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "companion-fm")
	script := `#!/bin/sh
case "$1" in
check) echo '{"models":[{"id":"apple-on-device","label":"Apple Intelligence","available":true}]}' ;;
run)
  read req
  echo '{"type":"tool_call","id":"c1","name":"create_task","args":"{\"title\":\"Buy milk\"}"}'
  read res
  echo '{"type":"delta","text":"Added Buy milk."}'
  echo '{"type":"done","text":"Added Buy milk."}' ;;
esac
`
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestRelayDrivesAppleIntelligenceFromAnotherDevice: a Mac hosts Apple Intelligence; a phone on
// the same account chats with it through the sync server. The turn runs on the Mac, the Mac's
// model calls a write tool against the Mac's store, and the new task reaches the phone by sync.
func TestRelayDrivesAppleIntelligenceFromAnotherDevice(t *testing.T) {
	helper := os.Getenv("COMPANION_FM_HELPER")
	live := helper != ""
	if !live {
		helper = scriptedHelper(t)
	}

	ts := newServer(t)
	tok := register(t, ts.URL, "fm@x.co", "password")
	mac, _ := newCore(t, "macos", true)
	phone, phoneLog := newCore(t, "ios", false)
	mac.SetFoundationModels(&agentrt.FoundationModels{HelperPath: helper})
	invoke(t, mac, "sync.configure", map[string]any{"baseUrl": ts.URL, "token": tok})
	invoke(t, phone, "sync.configure", map[string]any{"baseUrl": ts.URL, "token": tok})
	// Close the Mac's relay inbox before the server shuts down, which waits on open streams.
	t.Cleanup(func() { _, _ = mac.Invoke("sync.disconnect", nil) })

	out := invoke(t, mac, "agents.install", map[string]any{"runtime": "apple-foundation", "name": "Apple Intelligence"})
	var agent struct {
		ID string `json:"id"`
	}
	json.Unmarshal(out, &agent)
	invoke(t, mac, "sync.run", nil)

	// The phone sees the Mac's agent online.
	deadline := time.Now().Add(5 * time.Second)
	for {
		invoke(t, phone, "sync.run", nil)
		time.Sleep(100 * time.Millisecond)
		var list []struct {
			Runtime    string `json:"runtime"`
			Online     bool   `json:"online"`
			HostedHere bool   `json:"hostedHere"`
		}
		json.Unmarshal(invoke(t, phone, "agents.list", nil), &list)
		if len(list) == 1 && list[0].Online {
			if list[0].HostedHere || list[0].Runtime != "apple-foundation" {
				t.Fatalf("phone's view of the agent is wrong: %+v", list[0])
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("phone never saw the Mac's Apple Intelligence online")
		}
	}

	// Models come from the Mac.
	if models := invoke(t, phone, "agents.models", map[string]any{"agentId": agent.ID}); string(models) != `["apple-on-device"]` {
		t.Fatalf("remote models = %s", models)
	}

	var chat struct {
		ID string `json:"id"`
	}
	json.Unmarshal(invoke(t, phone, "chats.create", map[string]any{}), &chat)
	invoke(t, phone, "chats.send", map[string]any{"chatId": chat.ID, "text": "Create a task titled Buy milk, due tomorrow, with no project.", "agentId": agent.ID, "model": "apple-on-device"})

	// The task the Mac's model created arrives on the phone.
	deadline = time.Now().Add(90 * time.Second)
	for {
		invoke(t, phone, "sync.run", nil)
		var d struct {
			Working bool `json:"working"`
		}
		json.Unmarshal(invoke(t, phone, "chats.get", map[string]any{"id": chat.ID}), &d)
		var tasks []struct {
			Title string `json:"title"`
		}
		json.Unmarshal(invoke(t, phone, "tasks.list", map[string]any{}), &tasks)
		found := false
		for _, task := range tasks {
			if strings.Contains(strings.ToLower(task.Title), "milk") {
				found = true
			}
		}
		if found && !d.Working {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the task never reached the phone; tasks=%+v streamed=%q", tasks, phoneLog.tokens())
		}
		time.Sleep(200 * time.Millisecond)
	}
	if phoneLog.tokens() == "" {
		t.Error("the phone should have streamed the Mac's reply live")
	}
	if live {
		t.Logf("live reply streamed to the phone: %q", phoneLog.tokens())
	}
}
