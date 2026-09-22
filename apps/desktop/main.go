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
	"runtime"
	"strings"

	"companion/core/agentrt"
	"companion/core/blob"
	"companion/core/bridge"
	"companion/core/oauth"
	"companion/core/secrets"
	"companion/core/store"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"github.com/wailsapp/wails/v3/pkg/services/notifications"
	"github.com/wailsapp/wails/v3/pkg/updater"
)

// The Vite build output. Run `make desktop-frontend` (or `make desktop`) to
// populate frontend/dist before `go build`.
//
//go:embed all:frontend/dist
var assets embed.FS

// captureWindowName names the quick-capture panel, which stays usable while an update installs
// (update_window.go).
const captureWindowName = "capture"

// The quick-capture window: the palette card (660 wide, up to ~460 tall) plus the transparent
// margin CaptureView leaves for its shadow.
const (
	captureWindowWidth  = 720
	captureWindowHeight = 520
)

// version is the release this binary was built as, stamped by the release workflow
// (-ldflags "-X main.version=1.2.3"). Empty in dev builds, which never self-update and keep
// their data apart from the installed release's (see databasePath).
var version string

// googleClientID / googleClientSecret are this app's Google OAuth client ("Desktop app" type in
// Google Cloud), stamped at build time like version:
//
//	-ldflags "-X main.googleClientID=… -X main.googleClientSecret=…"
//
// or taken from COMPANION_GOOGLE_CLIENT_ID / COMPANION_GOOGLE_CLIENT_SECRET in a dev run. Google
// requires the "secret" of a desktop client in the token exchange, but it is not confidential — it
// ships in every copy of the app — and PKCE is what actually protects the flow. Left empty,
// Google sign-in is simply not offered (PLAN-caldav.md §9).
var googleClientID, googleClientSecret string

func main() {
	// An update restart re-runs this binary as the Wails updater's helper (updates.go): it waits
	// for the running app to exit, swaps the new bundle in, relaunches it and exits. application.New
	// checks for this too, but only after main has opened the database and the rest; catch it first.
	updater.HandleHelperMode()

	dev := version == ""
	dbPath, err := databasePath(dev)
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
	// Scheduled folder and Git exports (core/export) are a desktop feature: the core keeps their
	// bare repositories beside the database and runs them on their schedules for as long as the
	// app sits in the menu bar.
	core.SetExportDir(filepath.Dir(dbPath))
	core.StartExportScheduler()
	// Local agents (PLAN-agents.md): only the desktop can scan this machine for Claude Code /
	// Codex / Ollama / LM Studio and run the CLI ones as child processes, so it injects the
	// discoverer and runner factory and declares itself able to host. Device identity is what
	// installed local agents are pinned to (and what other devices route to).
	if id := firstNonEmpty(os.Getenv("COMPANION_GOOGLE_CLIENT_ID"), googleClientID); id != "" {
		secret := firstNonEmpty(os.Getenv("COMPANION_GOOGLE_CLIENT_SECRET"), googleClientSecret)
		// No redirect URI: the desktop receives the sign-in on a loopback port picked per flow.
		core.SetOAuthProvider(oauth.Google(id, secret, ""))
	}
	core.SetDeviceInfo(desktopPlatform(), defaultDeviceName(), true)
	core.SetAgentDiscoverer(agentrt.NewDiscoverer())
	core.SetAgentRunners(agentrt.NewFactory(filepath.Dir(dbPath)))

	// Reminder delivery (PLAN §6.4): the Wails notifications service registers real OS
	// notifications for the plan core computes. Registering it as a service runs its
	// platform Startup so authorization + scheduling work. macOS only delivers from a
	// bundled .app with a bundle identifier — not from `go run`/unbundled dev builds.
	notifSvc := notifications.New()
	bundled := runningFromBundle()
	notifHandler := newNotificationsHandler(notifSvc, bundled)

	// Assigned right after the app is built; the /window handler (below) captures it by
	// reference and only runs once requests arrive, so the app is set by then. mainWindow
	// is likewise captured by the /chrome handler (declared here so it's in scope for
	// Options) and assigned just below.
	var app *application.App
	var mainWindow *application.WebviewWindow
	// Native table context menu (editor tables). Built after the window exists; the
	// /table-menu handler captures it by reference, so it's set before any request arrives.
	var tableCtxMenu *tableMenu
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

	// Quick capture (Option+Space on macOS, Option+Shift+Space elsewhere — rebindable in
	// Settings › Shortcuts): a frameless panel holding the command palette — capture a task, note
	// or canvas, or find something and open it in the main window (palette.go).
	// It's presented Spotlight-style — floating in over whatever you're doing without pulling
	// Companion (or its main window) to the foreground, and dismissed by just closing that one
	// window: Esc, a click outside it, another app taking focus, or the shortcut again. Nilled
	// on close so the next press builds a fresh one. Frameless + transparent lets the webview draw its own
	// rounded, shadowed card (packages/app CaptureView) — see the ?capture=1 route in App.tsx.
	// The card hangs from the top of the window and grows with its results, so the window is
	// sized for the palette at its tallest; the rest of it stays see-through.
	var captureWindow *application.WebviewWindow
	openCaptureWindow := func() {
		// The shortcut is a toggle, like Spotlight's: pressed while the palette is up, it puts it
		// away again (the WindowClosing listener below forgets it).
		if captureWindow != nil {
			captureWindow.Close()
			return
		}
		win := app.Window.NewWithOptions(application.WebviewWindowOptions{
			Name:          captureWindowName,
			Title:         "Quick Capture",
			Width:         captureWindowWidth,
			Height:        captureWindowHeight,
			DisableResize: true,
			Frameless:     true,
			// Created hidden: Wails' own show activates the whole app. We surface it ourselves
			// via presentCapturePanel (orderFrontRegardless — no app activation) below.
			Hidden:           true,
			BackgroundType:   application.BackgroundTypeTransparent,
			BackgroundColour: application.NewRGBA(0, 0, 0, 0),
			InitialPosition:  application.WindowCentered,
			URL:              "/?capture=1",
			// Esc is the palette's: it steps back out of a command before it closes, via a
			// capture-phase keydown handler (packages/app CommandPalette). A native Wails
			// keybinding can't do that — and is swallowed by a focused ProseMirror editor — so
			// it's intentionally not set here.
			Mac: application.MacWindow{
				Backdrop: application.MacBackdropTransparent,
				// The window content is transparent except for the CaptureView card, which
				// draws its own rounded corners + shadow. macOS's native window shadow on a
				// transparent (non-opaque) window is computed before the web content paints,
				// so it renders as a hard rectangle behind the card — disable it and let the
				// CSS card shadow be the only one.
				DisableShadow: true,
			},
		})
		// Just forget the window on close (Esc / the shortcut / after a save) so the next
		// shortcut press builds a fresh one. Nothing else to do: because presenting it never activated
		// the app, closing it doesn't promote the main window or otherwise disturb focus.
		win.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) {
			captureWindow = nil
		})
		captureWindow = win
		presentCapturePanel(win)
	}

	// Owns the OS-wide quick-capture binding and the user's saved override. Built before the
	// app so the asset handler can close over it; the actual OS registration waits for
	// start(app) below, once the app exists.
	shortcuts := newShortcutManager(shortcutPrefsPath(dbPath), openCaptureWindow)

	// File › Export and the save panel its files go through (export.go). Built before the app,
	// like the shortcut manager, so the asset handler can route to it.
	exports := newExportService(func() *application.App { return app })

	// The notifications service only starts inside a signed .app bundle (it needs a bundle
	// identifier); registering it from `go run` aborts startup. Skip it in dev so the app
	// still runs — reminders then no-op until launched via `make desktop-app-run`.
	var services []application.Service
	if bundled {
		services = append(services, application.NewService(notifSvc))
	} else {
		log.Printf("notify: not running from an app bundle; OS notifications disabled (use make desktop-app-run)")
	}

	// Forced updates (updates.go): release builds running from an .app bundle only. The
	// service also decides what a launch shows — the updater window if an update is out, the
	// main window otherwise — and answers every way of opening Companion (update_window.go).
	// Built before the app so the asset handler can serve its state; attached once the main
	// window exists.
	updates := newUpdateService(version, runningBundle())
	updates.markerPath = relaunchMarkerPath(dbPath)
	// An update restart while the main window was closed to the menu bar comes back hidden.
	startHidden := consumeRelaunchMarker(updates.markerPath)

	app = application.New(application.Options{
		Name:        "Companion",
		Description: "Offline-first notes, tasks, habits, and calendar.",
		Services:    services,
		// Single instance (PLAN §6.4): as a menu-bar app we stay running with the window
		// hidden. Without this, tapping a reminder (or relaunching from the Dock) starts a
		// *second* process that opens its own window; the lock forwards that launch to the
		// running instance instead, which just surfaces its window.
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: instanceID(dev),
			OnSecondInstanceLaunch: func(application.SecondInstanceData) {
				updates.openApp()
			},
		},
		Assets: application.AssetOptions{
			Handler: rootHandler(handler, notifHandler, openFocusWindow, func(w http.ResponseWriter, r *http.Request) {
				tableCtxMenu.handleOpen(w, r)
			}, shortcuts.handleShortcuts, windowChromeHandler(func() *application.WebviewWindow { return mainWindow }), updates.handleState,
				pickThingsHandler(func() *application.App { return app }),
				paletteOpenHandler(updates.openApp, handler.OnEvent), exports),
		},
	})

	// Transparent titlebar: the standard window controls stay, but the titlebar is
	// see-through and content extends to the top edge, so the app's own toolbar
	// reads as the window chrome. Background matches the app canvas (#f5f5f3).
	// Created hidden: the update service shows it once the launch's update check has answered
	// (update_window.go). It loads meanwhile, so it's ready when it shows.
	mainWindow = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             "main",
		Title:            "Companion",
		Width:            1000,
		Height:           720,
		MinWidth:         600,
		MinHeight:        400,
		BackgroundColour: application.NewRGB(245, 245, 243),
		URL:              "/",
		Hidden:           true,
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
		updates.openApp()
		log.Printf("notify: deep-linking to task %s (emitting notify.activate)", taskID)
		payload, _ := json.Marshal(map[string]string{"taskId": taskID})
		handler.OnEvent("notify.activate", payload)
	})

	// Check on launch (before anything shows), hourly and on wake; the tray also offers a
	// manual check.
	checkForUpdates := updates.attach(app, mainWindow, !startHidden)

	installMenuBar(app, updates.openApp, checkForUpdates)

	// File › New Note / Task / Canvas: bring the window forward and have the app open the
	// palette on that command (palette.go). File › Import › Things 3… (PLAN §6.12): likewise,
	// for its import modal.
	// File › Export › Schedule … Exports: bring the window forward and have the app open
	// Settings › Export on a new export of that kind.
	exports.schedule = func(kind string) {
		updates.openApp()
		payload, _ := json.Marshal(map[string]string{"kind": kind})
		handler.OnEvent(exportScheduleEvent, payload)
	}
	app.Menu.Set(applicationMenu(func(what string) {
		updates.openApp()
		handler.OnEvent(captureNewEvent, captureNewPayload(what))
	}, func() {
		updates.openApp()
		handler.OnEvent(importThingsEvent, nil)
	}, func() {
		closeTabOrWindow(app.Window.Current(), mainWindow, func() { handler.OnEvent(tabCloseEvent, nil) })
	}, exports))

	// Register the native table context menu now that the app + window exist. The /table-menu
	// route (set up above, capturing tableCtxMenu by reference) drives it.
	tableCtxMenu = installTableMenu(app, mainWindow)

	// Global quick-capture shortcut (PLAN §6.4): a system-wide binding opens the capture
	// window even when Companion isn't focused — the whole point of staying resident in the
	// menu bar. The manager owns the registration and the user's saved override (see
	// shortcuts.go); the webview rebinds it through /shortcuts. The OS binding itself is
	// deferred until Run().
	shortcuts.start(app)

	if err := app.Run(); err != nil {
		log.Fatalf("run app: %v", err)
	}
}

// rootHandler serves the embedded frontend at "/" and routes the core bridge API
// (/invoke, /events) to the bridge handler. /window spawns a focus-mode window for a
// document (the workspace's expand/pop-out action) — browser window.open can't create a
// real app window in the Wails webview, so the frontend asks the Go side here.
func rootHandler(bridge *bridgeHandler, notify *notificationsHandler, openFocusWindow func(url string), openTableMenu http.HandlerFunc, shortcuts http.HandlerFunc, chrome http.HandlerFunc, updates http.HandlerFunc, pickThings http.HandlerFunc, paletteOpen http.HandlerFunc, exports *exportService) http.Handler {
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
	// Present the native table context menu at a point (the editor posts the menu state here).
	mux.HandleFunc("/table-menu", openTableMenu)
	// Read/rebind the OS-wide shortcuts (Settings › Shortcuts).
	mux.HandleFunc("/shortcuts", shortcuts)
	// Where the native window buttons sit over the page (macOS), so the UI can clear them.
	mux.HandleFunc("/chrome", chrome)
	// The forced-update state, for a window that opens mid-update (updates.go).
	mux.HandleFunc("/update", updates)
	// The native open panel for choosing a Things database to import (import_things.go).
	mux.HandleFunc("/import/things/pick", pickThings)
	// The quick-capture palette opening a result in the main window (palette.go).
	mux.HandleFunc("/palette/open", paletteOpen)
	// File › Export (export.go): which formats the menu offers, and the save-panel session the
	// exported files are written through.
	mux.HandleFunc("/export/menu", exports.handleMenu)
	mux.HandleFunc("/export/begin", exports.handleBegin)
	mux.HandleFunc("/export/write", exports.handleWrite)
	mux.HandleFunc("/export/end", exports.handleEnd)
	// The folder chooser for a scheduled filesystem export.
	mux.HandleFunc("/export/pick-folder", exports.handlePickFolder)
	mux.Handle("/", files)
	return mux
}

// databasePath returns the per-user SQLite location, creating the parent directory. Everything
// else the app keeps on disk (blobs, secrets, shortcuts, agent working dirs) sits beside it.
//
// A dev build is a separate app from the installed release, with its own folder: running from
// source would otherwise migrate and write over the release's database, and an unreleased
// migration recorded there is never re-run when its final version ships. Its single-instance
// lock is separate too (instanceID), and `make desktop-app` gives dev bundles their own bundle
// id, which keeps WebKit's localStorage (the sync config) apart as well.
func databasePath(dev bool) (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	name := "Companion"
	if dev {
		name = "Companion Dev"
	}
	appDir := filepath.Join(dir, name)
	if err := os.MkdirAll(appDir, 0o700); err != nil {
		return "", err
	}
	return filepath.Join(appDir, "companion.db"), nil
}

// instanceID keys the single-instance lock. A dev build takes its own, so launching one isn't
// handed off to the release sitting in the menu bar.
func instanceID(dev bool) string {
	if dev {
		return "com.companion.desktop.dev"
	}
	return "com.companion.desktop"
}

// desktopPlatform is the device platform id shown in Settings › Sync and synced to the server.
func desktopPlatform() string {
	switch runtime.GOOS {
	case "darwin":
		return "macos"
	default:
		return runtime.GOOS
	}
}

// defaultDeviceName is the host's name until the user renames the device ("Chris's MacBook Pro"
// on macOS comes through as "Chriss-MacBook-Pro.local"; trim the suffix and un-dash it).
func defaultDeviceName() string {
	host, err := os.Hostname()
	if err != nil || host == "" {
		return "This computer"
	}
	host = strings.TrimSuffix(host, ".local")
	host = strings.TrimSuffix(host, ".lan")
	return strings.ReplaceAll(host, "-", " ")
}

// runningFromBundle reports whether the executable lives inside a macOS .app bundle, which
// is what gives it a bundle identifier. Non-macOS builds always report true.
func runningFromBundle() bool {
	if runtime.GOOS != "darwin" {
		return true
	}
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	return strings.Contains(exe, ".app/Contents/MacOS/")
}

// firstNonEmpty returns the first non-blank value.
func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
