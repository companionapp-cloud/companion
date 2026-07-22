package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Global shortcuts (PLAN §6.4). The OS-wide quick-capture binding is user-configurable and
// device-local: it's a per-machine ergonomic choice, and only this shell can register it, so
// it lives in a small JSON file beside the database rather than in the synced core. The
// webview reads and rebinds it over /shortcuts (see rootHandler).

// defaultCaptureShortcut is the platform's built-in quick-capture binding.
//
// macOS gets Option+Space: ⌥Space only shadows typing a non-breaking space, and the obvious
// neighbours are taken (⌘Space is Spotlight, ⌃Space is input-source switching and IDE
// autocomplete). Windows and Linux add Shift because plain Alt+Space opens the window menu
// on Windows and is a move/resize binding in several Linux window managers.
func defaultCaptureShortcut() string {
	if runtime.GOOS == "darwin" {
		return "Option+Space"
	}
	return "Option+Shift+Space"
}

// shortcutPrefs is the on-disk shape. Absent or unparseable fields fall back to the
// platform default, so a corrupt file degrades to stock bindings instead of no bindings.
type shortcutPrefs struct {
	Capture string `json:"capture,omitempty"`
}

// shortcutManager owns the live OS registration and its persisted value. Every mutation
// goes through set(), which keeps the two in step: the OS binding is only replaced if the
// new accelerator is accepted, and the file is only written if the OS binding took.
type shortcutManager struct {
	path      string
	onCapture func()

	mu      sync.Mutex
	app     *application.App
	capture string
}

func newShortcutManager(path string, onCapture func()) *shortcutManager {
	m := &shortcutManager{path: path, onCapture: onCapture, capture: defaultCaptureShortcut()}
	var prefs shortcutPrefs
	if data, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(data, &prefs); err == nil && prefs.Capture != "" {
			m.capture = prefs.Capture
		}
	}
	return m
}

// start registers the stored binding once the app exists. A stored accelerator the OS now
// refuses (a shortcut another app has since claimed, or one carried over from a different
// platform) falls back to the default rather than leaving quick capture unreachable.
func (m *shortcutManager) start(app *application.App) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.app = app
	if err := app.GlobalShortcut.Register(m.capture, m.onCapture); err == nil {
		return
	}
	fallback := defaultCaptureShortcut()
	if fallback == m.capture {
		return
	}
	if err := app.GlobalShortcut.Register(fallback, m.onCapture); err != nil {
		return
	}
	m.capture = fallback
	m.persistLocked()
}

// set rebinds quick capture. On any failure the previous binding is restored, so a rejected
// accelerator leaves the user with a working shortcut rather than none.
func (m *shortcutManager) set(accelerator string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.app == nil {
		return errors.New("shortcuts are not ready yet")
	}
	if accelerator == m.capture {
		return nil
	}
	previous := m.capture
	if err := m.app.GlobalShortcut.Unregister(previous); err != nil {
		return err
	}
	if err := m.app.GlobalShortcut.Register(accelerator, m.onCapture); err != nil {
		// Put the old binding back; ignore a failure re-registering something the OS
		// accepted moments ago — there's nothing further to fall back to.
		_ = m.app.GlobalShortcut.Register(previous, m.onCapture)
		return err
	}
	m.capture = accelerator
	m.persistLocked()
	return nil
}

func (m *shortcutManager) current() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.capture
}

// persistLocked writes the prefs file. Callers hold m.mu. A write failure is not fatal: the
// binding is live for this session and simply won't survive a restart.
func (m *shortcutManager) persistLocked() {
	data, err := json.Marshal(shortcutPrefs{Capture: m.capture})
	if err != nil {
		return
	}
	_ = os.WriteFile(m.path, data, 0o600)
}

// shortcutBinding is the wire shape shared with packages/app's ShortcutBinding.
type shortcutBinding struct {
	ID                 string `json:"id"`
	Accelerator        string `json:"accelerator"`
	DefaultAccelerator string `json:"defaultAccelerator"`
}

func (m *shortcutManager) binding() shortcutBinding {
	return shortcutBinding{ID: "capture", Accelerator: m.current(), DefaultAccelerator: defaultCaptureShortcut()}
}

// handleShortcuts serves GET (list the bindings) and POST (rebind one) at /shortcuts. A
// rejected accelerator answers 422 with the OS/parser message, which the settings UI shows
// verbatim — "'foo' is not a valid key" is more useful than a generic failure.
func (m *shortcutManager) handleShortcuts(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, []shortcutBinding{m.binding()})
	case http.MethodPost:
		var req struct {
			ID          string `json:"id"`
			Accelerator string `json:"accelerator"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Accelerator == "" {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if req.ID != "capture" {
			http.Error(w, "unknown shortcut", http.StatusNotFound)
			return
		}
		if err := m.set(req.Accelerator); err != nil {
			http.Error(w, err.Error(), http.StatusUnprocessableEntity)
			return
		}
		writeJSON(w, http.StatusOK, m.binding())
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// shortcutPrefsPath is the prefs file beside the database, matching secrets.json.
func shortcutPrefsPath(dbPath string) string {
	return filepath.Join(filepath.Dir(dbPath), "shortcuts.json")
}
