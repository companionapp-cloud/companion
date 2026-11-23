package term

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"companion/core/bridge"
	"companion/core/domain"
	"companion/core/mcp"
	"companion/core/store"
)

// liveClient is a client for a real core serving terminal access with writes allowed.
func liveClient(t *testing.T) (*Client, *bridge.Core) {
	t.Helper()
	st, err := store.Open(":memory:", domain.SystemClock{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	core := bridge.New(st)
	dir := t.TempDir()
	if err := core.SetTerminalAgents(dir, "companion"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(core.StopTerminalAgents)
	if _, err := core.Invoke("terminalAgents.update", []byte(`{"enabled":true,"allowWrite":true}`)); err != nil {
		t.Fatal(err)
	}
	return &Client{ConfigPath: filepath.Join(dir, mcp.TerminalConfigFile)}, core
}

func TestNewNoteAndTask(t *testing.T) {
	c, core := liveClient(t)
	var out bytes.Buffer
	if err := RunNew(c, []string{"note", "Standup", "notes", "--body", "- shipped it"}, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "Standup notes") {
		t.Errorf("output = %q", out.String())
	}
	if err := RunNew(c, []string{"task", "--due", "tomorrow 5pm", "Call", "Sam"}, &out); err != nil {
		t.Fatal(err)
	}
	var tasks []task
	if err := c.Invoke("tasks.list", nil, &tasks); err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 || tasks[0].Title != "Call Sam" || tasks[0].DueAt == nil || tasks[0].DueAt.Local().Hour() != 17 {
		t.Fatalf("tasks = %+v", tasks)
	}
	var notes []note
	_ = c.Invoke("notes.list", nil, &notes)
	if len(notes) != 1 || notes[0].ContentMD != "- shipped it" {
		t.Fatalf("notes = %+v", notes)
	}

	// A date that doesn't read creates nothing and says why (the Rex plugin asks again on it).
	err := RunNew(c, []string{"task", "Nope", "--due", "blorp"}, &out)
	if err == nil || !strings.Contains(err.Error(), "as a date") {
		t.Fatalf("bad date err = %v", err)
	}
	_ = c.Invoke("tasks.list", nil, &tasks)
	if len(tasks) != 1 {
		t.Errorf("a failed create left %d tasks", len(tasks))
	}

	// Read-only refuses writes with a pointer to the setting.
	if _, err := core.Invoke("terminalAgents.update", []byte(`{"allowWrite":false}`)); err != nil {
		t.Fatal(err)
	}
	if err := RunNew(c, []string{"note", "x"}, &out); err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Fatalf("read-only err = %v", err)
	}
}

func TestRexInstallReplacesItsLine(t *testing.T) {
	home := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", home)
	t.Setenv("REX_CONFIG", "")
	initPath := filepath.Join(home, "rex", "init.lua")
	if err := os.MkdirAll(filepath.Dir(initPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(initPath, []byte("rex.bind(\"cmd+k\", \"x\")\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	for _, bin := range []string{"/old/companion", "companion"} {
		if err := RexInstall(bin, &out); err != nil {
			t.Fatal(err)
		}
	}
	data, _ := os.ReadFile(initPath)
	got := string(data)
	if strings.Count(got, rexMarker) != 1 || strings.Contains(got, "/old/") || !strings.HasPrefix(got, "rex.bind") {
		t.Fatalf("init.lua =\n%s", got)
	}
	if _, err := os.Stat(filepath.Join(home, "rex", "plugins", "companion", "init.lua")); err != nil {
		t.Fatal(err)
	}
}
