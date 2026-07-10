package main

import (
	"encoding/json"
	"net/http"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// tableMenu is the desktop-native context menu for editor tables (PLAN: notes editor tables).
// The webview owns all table logic; it only asks the Go side to *present* a native menu. Right
// before opening, the webview posts the menu state (which items are enabled + the current column
// alignment) and a correlation token to POST /table-menu; a click emits "table:action" back with
// the chosen id + token so the webview runs the matching ProseMirror command.
//
// The item ids mirror packages/editor/src/tableCommands.ts — keep the two in sync.
type tableMenu struct {
	window *application.WebviewWindow
	items  map[string]*application.MenuItem // action id -> native item, for enable/check updates
}

// tableMenuOpen is the request the webview posts just before opening the menu.
type tableMenuOpen struct {
	X       int             `json:"x"`
	Y       int             `json:"y"`
	Corr    string          `json:"corr"`
	Enabled map[string]bool `json:"enabled"` // id -> enabled (missing = enabled)
	Checked map[string]bool `json:"checked"` // id -> checked (align options)
}

// installTableMenu registers the "companion-table" context menu and returns the handle whose
// HTTP route the frontend calls to open it. Built after the main window exists so item clicks
// can emit back to it.
func installTableMenu(app *application.App, window *application.WebviewWindow) *tableMenu {
	tm := &tableMenu{window: window, items: map[string]*application.MenuItem{}}
	menu := application.NewContextMenu("companion-table")

	add := func(parent *application.Menu, id, label string) {
		item := parent.Add(label)
		item.OnClick(func(ctx *application.Context) {
			// ctx.ContextMenuData() is the correlation token we passed to OpenContextMenu.
			tm.window.EmitEvent("table:action", map[string]string{"id": id, "corr": ctx.ContextMenuData()})
		})
		tm.items[id] = item
	}

	copyAs := menu.AddSubmenu("Copy table as")
	add(copyAs, "copy.md", "Markdown")
	add(copyAs, "copy.html", "HTML")
	add(copyAs, "copy.csv", "CSV")

	alignCol := menu.AddSubmenu("Align column")
	add(alignCol, "align.left", "Left")
	add(alignCol, "align.right", "Right")
	add(alignCol, "align.center", "Center")

	menu.AddSeparator()
	add(menu.Menu, "row.add.below", "Add Row")
	add(menu.Menu, "row.add.above", "Add Row Above")
	add(menu.Menu, "col.add.after", "Add Column")
	add(menu.Menu, "col.add.before", "Add Column Before")

	menu.AddSeparator()
	add(menu.Menu, "row.move.up", "Move Row Up")
	add(menu.Menu, "row.move.down", "Move Row Down")
	add(menu.Menu, "col.move.left", "Move Column Left")
	add(menu.Menu, "col.move.right", "Move Column Right")

	menu.AddSeparator()
	add(menu.Menu, "row.delete", "Delete Row")
	add(menu.Menu, "col.delete", "Delete Column")

	app.ContextMenu.Add("companion-table", menu)
	return tm
}

// handleOpen updates item enabled/checked state from the posted model, then opens the native
// menu at the given point. Menu mutation + presentation must run on the main thread.
func (tm *tableMenu) handleOpen(w http.ResponseWriter, r *http.Request) {
	if tm == nil {
		http.Error(w, "table menu unavailable", http.StatusServiceUnavailable)
		return
	}
	var req tableMenuOpen
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	application.InvokeSync(func() {
		for id, item := range tm.items {
			enabled, present := req.Enabled[id]
			item.SetEnabled(!present || enabled) // default to enabled when unspecified
			item.SetChecked(req.Checked[id])     // false clears the check for non-align items
		}
		tm.window.OpenContextMenu(&application.ContextMenuData{Id: "companion-table", X: req.X, Y: req.Y, Data: req.Corr})
	})
	w.WriteHeader(http.StatusNoContent)
}
