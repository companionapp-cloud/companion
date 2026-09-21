package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Exporting documents on the desktop. The webview does the exporting itself — it renders a note,
// a task or a canvas to PDF, PNG, HTML, text or markdown (packages/app/src/export). The desktop
// contributes the two things a webview can't do: the File › Export menu, and writing the files
// where the user says, through the native save panel.

// exportRequestEvent asks a window to export what it's showing, as {"format": …}. Unlike the
// File › New items it's delivered to the focused window alone, not the core's event stream: a
// note popped out into its own window exports that note, not the main window's tab.
const exportRequestEvent = "export:request"

// exportScheduleEvent asks the main window to open a settings section and start something
// there, as {"kind": …}: "folder" a new scheduled filesystem export (Settings › Export), "git"
// Git sync setup (Settings › Sync), "import" the Markdown file importer (Settings › Import). It travels the core's event stream, like File ›
// Import (import_things.go): scheduled exports are the app's, not one window's.
const exportScheduleEvent = "export.schedule"

// exportFormats is the Export submenu, in order. The ids mirror EXPORT_FORMATS in
// packages/app/src/export/types.ts — keep the two in sync.
var exportFormats = []struct{ id, label string }{
	{"pdf", "PDF…"},
	{"png", "PNG…"},
	{"html", "HTML…"},
	{"txt", "Text…"},
	{"md", "Markdown…"},
}

// exportSessionTTL is how long an export may go without writing before its session is dropped.
const exportSessionTTL = 30 * time.Minute

// maxExportFile caps one exported file (a long note as a PDF runs to tens of megabytes).
const maxExportFile = 1 << 30

// exportSession is one export in flight: where the save panel said to write.
type exportSession struct {
	file    string // single-file export: the exact path chosen
	dir     string // several files: the folder chosen
	written map[string]bool
	touched time.Time
}

type exportService struct {
	app func() *application.App
	// schedule shows the main window and opens Settings › Export on a new export of that kind.
	schedule func(kind string)

	mu       sync.Mutex
	items    map[string]*application.MenuItem
	sessions map[string]*exportSession
}

func newExportService(app func() *application.App) *exportService {
	return &exportService{app: app, schedule: func(string) {}, items: map[string]*application.MenuItem{}, sessions: map[string]*exportSession{}}
}

// addMenu adds the Export submenu to File: the formats what's on screen can be saved as, then
// the scheduled exports. Every format starts disabled: the focused window enables the ones that
// apply to what it's showing (handleMenu). The scheduling items are always on.
func (s *exportService) addMenu(file *application.Menu) {
	export := file.AddSubmenu("Export")
	for _, f := range exportFormats {
		format := f.id
		item := export.Add(f.label).SetEnabled(false)
		item.OnClick(func(*application.Context) { s.request(format) })
		s.items[format] = item
	}
	export.AddSeparator()
	export.Add("Schedule Filesystem Exports…").OnClick(func(*application.Context) { s.schedule("folder") })
	export.Add("Git Sync…").OnClick(func(*application.Context) { s.schedule("git") })
}

// handlePickFolder answers POST /export/pick-folder[?purpose=import] with the folder chosen —
// to export to, or to import from — as {"path": …}, or 204 when the user cancelled. The core, which runs in this
// process, writes to the path itself.
func (s *exportService) handlePickFolder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	title, message := "Export to Folder", "Choose the folder Companion keeps a copy of your notes, tasks and canvases in. An empty folder is best: Companion replaces files it finds with the same names."
	if r.URL.Query().Get("purpose") == "import" {
		title, message = "Import Markdown Files", "Choose the folder to import: a Companion export, an Obsidian vault, or any folder of Markdown notes. Nothing in it is changed."
	}
	path, err := s.app().Dialog.OpenFile().
		SetTitle(title).
		SetMessage(message).
		SetButtonText("Choose").
		CanChooseFiles(false).
		CanChooseDirectories(true).
		CanCreateDirectories(true).
		PromptForSingleSelection()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if path == "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"path": path})
}

// request tells the focused window to export in the given format.
func (s *exportService) request(format string) {
	window, ok := s.app().Window.Current().(*application.WebviewWindow)
	if !ok || window == nil {
		return
	}
	window.DispatchWailsEvent(&application.CustomEvent{Name: exportRequestEvent, Data: map[string]string{"format": format}})
}

// handleMenu answers POST /export/menu, the focused window saying which formats apply to what
// it's showing ({"formats": ["pdf","png"]} for a canvas; none when nothing exportable is open).
// Formats that apply are shown and enabled. With none, the whole list stays visible but
// disabled, so the menu still says what Export offers.
func (s *exportService) handleMenu(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Formats []string `json:"formats"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	enabled := map[string]bool{}
	for _, f := range req.Formats {
		enabled[f] = true
	}
	// Menu mutation must run on the main thread.
	application.InvokeSync(func() {
		for id, item := range s.items {
			item.SetHidden(len(enabled) > 0 && !enabled[id])
			item.SetEnabled(enabled[id])
		}
	})
	w.WriteHeader(http.StatusNoContent)
}

// handleBegin answers POST /export/begin ({"count": n, "name": …}) by asking where to save: a
// save panel pre-filled with the filename for one file, a folder chooser for several. It returns
// {"token": …, "location": …} for the writes that follow, or 204 when the user cancelled.
func (s *exportService) handleBegin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Count int    `json:"count"`
		Name  string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil || req.Count < 1 {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	session := &exportSession{written: map[string]bool{}, touched: time.Now()}
	var err error
	if req.Count == 1 {
		name := safeExportName(req.Name)
		dialog := s.app().Dialog.SaveFile().SetFilename(name).CanCreateDirectories(true)
		if ext := strings.TrimPrefix(filepath.Ext(name), "."); ext != "" {
			dialog.AddFilter(strings.ToUpper(ext), "*."+ext)
		}
		session.file, err = dialog.PromptForSingleSelection()
	} else {
		session.dir, err = s.app().Dialog.OpenFile().
			SetTitle("Export").
			SetMessage(fmt.Sprintf("Choose a folder for the %d exported files.", req.Count)).
			SetButtonText("Export").
			CanChooseFiles(false).
			CanChooseDirectories(true).
			CanCreateDirectories(true).
			PromptForSingleSelection()
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	location := session.file
	if location == "" {
		location = session.dir
	}
	if location == "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	token := hex.EncodeToString(raw)
	s.mu.Lock()
	for t, old := range s.sessions {
		if time.Since(old.touched) > exportSessionTTL {
			delete(s.sessions, t)
		}
	}
	s.sessions[token] = session
	s.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"token": token, "location": location})
}

// handleWrite answers POST /export/write?token=…&name=… with the file's bytes as the body. The
// page never names a path: a single-file session writes to the path its save panel returned (the
// panel has already confirmed replacing it), a folder session writes `name` — reduced to a bare
// filename — inside its folder, stepping aside ("Plan 2.pdf") rather than replacing a file that
// was already there.
func (s *exportService) handleWrite(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.mu.Lock()
	session := s.sessions[r.URL.Query().Get("token")]
	var path string
	if session != nil {
		session.touched = time.Now()
		path = session.file
		if path == "" {
			path = session.freePath(safeExportName(r.URL.Query().Get("name")))
		}
	}
	s.mu.Unlock()
	if session == nil {
		http.Error(w, "unknown export", http.StatusNotFound)
		return
	}

	if err := writeExportFile(path, http.MaxBytesReader(w, r.Body, maxExportFile)); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleEnd answers POST /export/end?token=…, closing the session.
func (s *exportService) handleEnd(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.mu.Lock()
	delete(s.sessions, r.URL.Query().Get("token"))
	s.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

// freePath is a path in the session's folder for `name` that neither an existing file nor an
// earlier write of this export holds. Called with the service lock held.
func (s *exportSession) freePath(name string) string {
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for n := 1; ; n++ {
		candidate := name
		if n > 1 {
			candidate = fmt.Sprintf("%s %d%s", stem, n, ext)
		}
		path := filepath.Join(s.dir, candidate)
		if s.written[strings.ToLower(path)] {
			continue
		}
		if _, err := os.Lstat(path); err == nil {
			continue
		}
		s.written[strings.ToLower(path)] = true
		return path
	}
}

// writeExportFile writes the body beside its destination and renames it into place, so a failed
// or cancelled export never leaves half a file under the real name.
func writeExportFile(path string, body io.Reader) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".companion-export-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := io.Copy(tmp, body); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// safeExportName reduces a name from the page to a bare filename: no directories, no leading
// dots, nothing a filesystem refuses.
func safeExportName(name string) string {
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || strings.ContainsRune(`/\:*?"<>|`, r) {
			return ' '
		}
		return r
	}, name)
	name = strings.TrimLeft(strings.Join(strings.Fields(name), " "), ". ")
	if name == "" {
		return "Export"
	}
	return name
}
