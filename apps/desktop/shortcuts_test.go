package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDefaultCaptureShortcutPerPlatform(t *testing.T) {
	got := defaultCaptureShortcut()
	want := "Option+Shift+Space"
	if runtime.GOOS == "darwin" {
		want = "Option+Space"
	}
	if got != want {
		t.Fatalf("defaultCaptureShortcut() on %s = %q, want %q", runtime.GOOS, got, want)
	}
}

func TestNewShortcutManagerDefaultsWhenNoFile(t *testing.T) {
	m := newShortcutManager(filepath.Join(t.TempDir(), "shortcuts.json"), func() {})
	if m.current() != defaultCaptureShortcut() {
		t.Fatalf("current() = %q, want the platform default %q", m.current(), defaultCaptureShortcut())
	}
}

func TestNewShortcutManagerReadsSavedBinding(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shortcuts.json")
	if err := os.WriteFile(path, []byte(`{"capture":"Ctrl+Shift+K"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	m := newShortcutManager(path, func() {})
	if m.current() != "Ctrl+Shift+K" {
		t.Fatalf("current() = %q, want the saved binding", m.current())
	}
}

// A truncated or hand-mangled prefs file must not cost the user their shortcut entirely.
func TestNewShortcutManagerFallsBackOnCorruptFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shortcuts.json")
	if err := os.WriteFile(path, []byte(`{"capture":`), 0o600); err != nil {
		t.Fatal(err)
	}
	m := newShortcutManager(path, func() {})
	if m.current() != defaultCaptureShortcut() {
		t.Fatalf("current() = %q, want the platform default after a corrupt read", m.current())
	}
}

func TestPersistRoundTrips(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shortcuts.json")
	m := newShortcutManager(path, func() {})
	m.capture = "Cmd+Option+C"
	m.persistLocked()

	if reloaded := newShortcutManager(path, func() {}); reloaded.current() != "Cmd+Option+C" {
		t.Fatalf("reloaded current() = %q, want the persisted binding", reloaded.current())
	}
}

func TestHandleShortcutsGetListsBinding(t *testing.T) {
	m := newShortcutManager(filepath.Join(t.TempDir(), "shortcuts.json"), func() {})
	rec := httptest.NewRecorder()
	m.handleShortcuts(rec, httptest.NewRequest(http.MethodGet, "/shortcuts", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var got []shortcutBinding
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "capture" {
		t.Fatalf("body = %+v, want one binding for capture", got)
	}
	if got[0].Accelerator != defaultCaptureShortcut() || got[0].DefaultAccelerator != defaultCaptureShortcut() {
		t.Fatalf("binding = %+v, want the platform default in both fields", got[0])
	}
}

func TestHandleShortcutsRejectsBadRequests(t *testing.T) {
	m := newShortcutManager(filepath.Join(t.TempDir(), "shortcuts.json"), func() {})
	cases := []struct {
		name, method, body string
		want               int
	}{
		{"empty accelerator", http.MethodPost, `{"id":"capture","accelerator":""}`, http.StatusBadRequest},
		{"malformed json", http.MethodPost, `{`, http.StatusBadRequest},
		{"unknown id", http.MethodPost, `{"id":"nope","accelerator":"Ctrl+K"}`, http.StatusNotFound},
		{"wrong method", http.MethodDelete, ``, http.StatusMethodNotAllowed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			m.handleShortcuts(rec, httptest.NewRequest(tc.method, "/shortcuts", strings.NewReader(tc.body)))
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d", rec.Code, tc.want)
			}
		})
	}
	// None of those touched the live binding.
	if m.current() != defaultCaptureShortcut() {
		t.Fatalf("current() = %q, want it unchanged after rejected requests", m.current())
	}
}

// Rebinding before the app exists must report an error rather than silently "succeeding"
// and persisting a binding the OS never took.
func TestSetBeforeStartFails(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shortcuts.json")
	m := newShortcutManager(path, func() {})
	if err := m.set("Ctrl+Shift+J"); err == nil {
		t.Fatal("set() before start() = nil error, want a failure")
	}
	if m.current() != defaultCaptureShortcut() {
		t.Fatalf("current() = %q, want it unchanged", m.current())
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("prefs file was written for a binding the OS never accepted")
	}
}
