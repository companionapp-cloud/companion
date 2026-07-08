// Command desktop is the Companion desktop client (PLAN §3.2). It is the cheapest
// binding: it imports core/ directly (no cgo/FFI boundary) and hosts a Wails v3
// webview. The webview runs the shared React Native (react-native-web) UI from
// packages/app, built by apps/desktop/frontend (Vite) into frontend/dist and
// embedded here. That UI reaches the in-process core through the string+JSON Invoke
// API, bridged over the Wails AssetServer handler (see bridge_handler.go).
package main

import (
	"embed"
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"

	"companion/core/blob"
	"companion/core/bridge"
	"companion/core/secrets"
	"companion/core/store"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"github.com/wailsapp/wails/v3/pkg/services/notifications"
)

// The Vite build output. Run `make desktop-frontend` (or `make desktop`) to
// populate frontend/dist before `go build`.
//
//go:embed all:frontend/dist
var assets embed.FS

func main() {
	dbPath, err := databasePath()
	if err != nil {
		log.Fatalf("resolve database path: %v", err)
	}
	st, err := store.Open(dbPath, nil)
	if err != nil {
		log.Fatalf("open store (%s): %v", dbPath, err)
	}
	defer st.Close()

	core := bridge.New(st)
	handler := newBridgeHandler(core)
	core.SetEventHandler(handler)
	// Document bytes (PLAN §6.9): a filesystem blob store beside the database. The core owns
	// blob sync; the webview embeds/renders through the invoke bridge (documents.ingestBytes /
	// documents.dataUrl), so no extra HTTP routes are needed.
	blobStore, err := blob.NewFSStore(filepath.Join(filepath.Dir(dbPath), "blobs"), nil)
	if err != nil {
		log.Fatalf("open blob store: %v", err)
	}
	core.SetBlobStore(blobStore)
	// LLM API keys (PLAN §6.8): stored beside the database in a 0600 file (keychain is the
	// later hardening upgrade). Local Ollama configs need no key and work without this.
	core.SetSecretStore(secrets.NewFileStore(filepath.Join(filepath.Dir(dbPath), "secrets.json")))

	// Reminder delivery (PLAN §6.4): the Wails notifications service registers real OS
	// notifications for the plan core computes. Registering it as a service runs its
	// platform Startup so authorization + scheduling work. macOS only delivers from a
	// bundled .app with a bundle identifier — not from `go run`/unbundled dev builds.
	notifSvc := notifications.New()
	notifHandler := newNotificationsHandler(notifSvc)

	// Assigned right after the app is built; the /window handler (below) captures it by
	// reference and only runs once requests arrive, so the app is set by then. mainWindow
	// is likewise captured by the single-instance callback (declared here so it's in scope
	// for Options) and assigned just below.
	var app *application.App
	var mainWindow *application.WebviewWindow
	openFocusWindow := func(url string) {
		app.Window.NewWithOptions(application.WebviewWindowOptions{
			Title:            "Companion",
			Width:            820,
			Height:           720,
			MinWidth:         480,
			MinHeight:        360,
			BackgroundColour: application.NewRGB(245, 245, 243),
			URL:              url,
			Mac: application.MacWindow{
				TitleBar: application.MacTitleBarHiddenInset,
			},
		})
	}

	app = application.New(application.Options{
		Name:        "Companion",
		Description: "Offline-first notes, tasks, habits, and calendar.",
		Services: []application.Service{
			application.NewService(notifSvc),
		},
		// Single instance (PLAN §6.4): as a menu-bar app we stay running with the window
		// hidden. Without this, tapping a reminder (or relaunching from the Dock) starts a
		// *second* process that opens its own window; the lock forwards that launch to the
		// running instance instead, which just surfaces its window.
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "com.companion.desktop",
			OnSecondInstanceLaunch: func(application.SecondInstanceData) {
				if mainWindow != nil {
					mainWindow.Show()
					mainWindow.Focus()
				}
			},
		},
		Assets: application.AssetOptions{
			Handler: rootHandler(handler, notifHandler, openFocusWindow),
		},
	})

	// Transparent titlebar: the standard window controls stay, but the titlebar is
	// see-through and content extends to the top edge, so the app's own toolbar
	// reads as the window chrome. Background matches the app canvas (#f5f5f3).
	mainWindow = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             "main",
		Title:            "Companion",
		Width:            1000,
		Height:           720,
		MinWidth:         600,
		MinHeight:        400,
		BackgroundColour: application.NewRGB(245, 245, 243),
		URL:              "/",
		Mac: application.MacWindow{
			TitleBar: application.MacTitleBarHiddenInset,
		},
	})

	// Run in the menu bar (PLAN §6.4): closing the main window hides it instead of
	// destroying it, so the process — and the reminders it schedules — stays alive. The
	// tray's Open reopens it; Quit exits for real. Registered as a *hook* (not a
	// listener) because a cancelling hook short-circuits Wails' built-in destroy
	// handler. Focus-mode pop-out windows keep the default close behaviour.
	mainWindow.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		e.Cancel()
		mainWindow.Hide()
	})

	// Tapping a reminder (PLAN §6.4): bring the app forward and tell the webview to
	// deep-link to the task. The frontend's ReminderNavigationBridge listens for the
	// notify.activate event on the same SSE stream the core uses.
	notifSvc.OnNotificationResponse(func(result notifications.NotificationResult) {
		if result.Error != nil {
			log.Printf("notify: response error: %v", result.Error)
			return
		}
		log.Printf("notify: response received id=%q action=%q userInfo=%v", result.Response.ID, result.Response.ActionIdentifier, result.Response.UserInfo)
		taskID := taskIDFromResponse(result.Response)
		if taskID == "" {
			log.Printf("notify: response has no resolvable taskId — not deep-linking")
			return
		}
		mainWindow.Show()
		mainWindow.Focus()
		log.Printf("notify: deep-linking to task %s (emitting notify.activate)", taskID)
		payload, _ := json.Marshal(map[string]string{"taskId": taskID})
		handler.OnEvent("notify.activate", payload)
	})

	installMenuBar(app, mainWindow)

	if err := app.Run(); err != nil {
		log.Fatalf("run app: %v", err)
	}
}

// rootHandler serves the embedded frontend at "/" and routes the core bridge API
// (/invoke, /events) to the bridge handler. /window spawns a focus-mode window for a
// document (the workspace's expand/pop-out action) — browser window.open can't create a
// real app window in the Wails webview, so the frontend asks the Go side here.
func rootHandler(bridge *bridgeHandler, notify *notificationsHandler, openFocusWindow func(url string)) http.Handler {
	frontend, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		log.Fatalf("mount frontend assets: %v", err)
	}
	files := http.FileServer(http.FS(frontend))

	mux := http.NewServeMux()
	mux.Handle("/invoke", bridge)
	mux.Handle("/events", bridge)
	mux.HandleFunc("/notify/authorize", notify.handleAuthorize)
	mux.HandleFunc("/notify/reconcile", notify.handleReconcile)
	mux.HandleFunc("/window", func(w http.ResponseWriter, r *http.Request) {
		kind := r.URL.Query().Get("kind")
		id := r.URL.Query().Get("id")
		if (kind != "note" && kind != "task") || id == "" {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		openFocusWindow("/?" + url.Values{kind: {id}}.Encode())
		w.WriteHeader(http.StatusNoContent)
	})
	mux.Handle("/", files)
	return mux
}

// databasePath returns the per-user SQLite location, creating the parent directory.
func databasePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	appDir := filepath.Join(dir, "Companion")
	if err := os.MkdirAll(appDir, 0o700); err != nil {
		return "", err
	}
	return filepath.Join(appDir, "companion.db"), nil
}
