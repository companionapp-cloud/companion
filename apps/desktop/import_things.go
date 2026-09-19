package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Things 3 import on the desktop (PLAN §6.12). Core does the import; the desktop contributes a
// File › Import › Things 3… menu item and the native open panel the import modal uses to pick
// Things' database.

// importThingsEvent asks the webview to open the import modal. It travels the core's event
// stream (like notify.activate), so the shared app handles it on every shell that sends it.
const importThingsEvent = "import.things"

// thingsGroupContainer is where Things 3 for Mac keeps its data (Cultured Code's team id).
const thingsGroupContainer = "JLMPQHK86H.com.culturedcode.ThingsMac"

// applicationMenu is the macOS default menu (app, File, Edit, View, Window, Help) with an
// Import submenu in File. openImport shows the window and opens the import modal.
func applicationMenu(openImport func()) *application.Menu {
	menu := application.NewMenu()
	if runtime.GOOS == "darwin" {
		menu.AddRole(application.AppMenu)
	}
	file := menu.AddSubmenu("File")
	file.AddSubmenu("Import").Add("Things 3…").OnClick(func(*application.Context) { openImport() })
	file.AddSeparator()
	if runtime.GOOS == "darwin" {
		file.AddRole(application.CloseWindow)
	} else {
		file.AddRole(application.Quit)
	}
	menu.AddRole(application.EditMenu)
	menu.AddRole(application.ViewMenu)
	menu.AddRole(application.WindowMenu)
	menu.AddRole(application.HelpMenu)
	return menu
}

// pickThingsHandler answers POST /import/things/pick with the Things database the user chose in
// the system open panel ({"path": …}), or 204 when they cancelled. The panel starts in Things'
// group container and lets the user pick the "Things Database.thingsdatabase" package whole. A
// file the user picks is readable without macOS's "access data from other apps" prompt (macOS
// 15+), which reading the path directly would raise — again after every update of this
// ad-hoc-signed app.
func pickThingsHandler(app func() *application.App) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		dialog := app().Dialog.OpenFile().
			SetTitle("Import from Things 3").
			SetMessage("Open the ThingsData folder and choose “Things Database.thingsdatabase”. Quit Things first so its latest changes are included.").
			SetButtonText("Choose").
			CanChooseFiles(true).
			CanChooseDirectories(true).
			TreatsFilePackagesAsDirectories(false).
			ResolvesAliases(true)
		if dir := thingsContainer(); dir != "" {
			dialog.SetDirectory(dir)
		}
		path, err := dialog.PromptForSingleSelection()
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
}

// thingsContainer is Things' group container on this Mac, for the open panel to start in; ""
// when Things isn't installed. Only its entry in Group Containers is checked — looking inside
// (even listing it) is what macOS 15+ guards with a prompt, and the panel, running out of
// process, can show it without one.
func thingsContainer() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	container := filepath.Join(home, "Library", "Group Containers", thingsGroupContainer)
	if info, err := os.Stat(container); err != nil || !info.IsDir() {
		return ""
	}
	return container
}
