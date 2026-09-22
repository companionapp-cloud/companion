package main

import (
	"encoding/json"
	"net/http"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Native right-click menus for the app's own context menus (packages/app/src/contextMenu.ts):
// a list row, a sidebar area or project, a reference chip, a canvas card or the canvas board.
// Unlike the fixed table menu (table_menu.go), the webview sends the whole menu each time —
// labels, separators, submenus, enabled and checked state — and this builds it fresh and opens
// it at the pointer. A click emits "context:action" back with the item id and the request's
// correlation token; the webview keeps the actions and runs the matching one.

const contextMenuName = "companion-context"

// contextMenuItem mirrors the editor's TableMenuItem, the model the app's presenters share.
type contextMenuItem struct {
	ID        string            `json:"id,omitempty"`
	Label     string            `json:"label,omitempty"`
	Enabled   *bool             `json:"enabled,omitempty"` // missing = enabled
	Checked   bool              `json:"checked,omitempty"`
	Separator bool              `json:"separator,omitempty"`
	Children  []contextMenuItem `json:"children,omitempty"`
}

type contextMenuOpen struct {
	X     int               `json:"x"`
	Y     int               `json:"y"`
	Corr  string            `json:"corr"`
	Items []contextMenuItem `json:"items"`
}

// addContextItems appends items to menu; pick is called with a leaf's id when it's clicked.
func addContextItems(menu *application.Menu, items []contextMenuItem, pick func(id string)) {
	for _, it := range items {
		switch {
		case it.Separator:
			menu.AddSeparator()
		case len(it.Children) > 0:
			addContextItems(menu.AddSubmenu(it.Label), it.Children, pick)
		default:
			var item *application.MenuItem
			if it.Checked {
				item = menu.AddCheckbox(it.Label, true)
			} else {
				item = menu.Add(it.Label)
			}
			if it.Enabled != nil && !*it.Enabled {
				item.SetEnabled(false)
			}
			id := it.ID
			item.OnClick(func(*application.Context) { pick(id) })
		}
	}
}

// contextMenuHandler answers POST /context-menu: build the posted menu and open it in the window
// that asked (the focused one), falling back to the main window.
func contextMenuHandler(main func() *application.WebviewWindow) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req contextMenuOpen
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.Items) == 0 {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		application.InvokeSync(func() {
			win := main()
			if cur, ok := application.Get().Window.Current().(*application.WebviewWindow); ok && cur != nil {
				win = cur
			}
			if win == nil {
				return
			}
			menu := application.NewContextMenu(contextMenuName)
			addContextItems(menu.Menu, req.Items, func(id string) {
				win.EmitEvent("context:action", map[string]string{"id": id, "corr": req.Corr})
			})
			// Registers the rebuilt menu under the shared name, replacing the last one.
			menu.Update()
			win.OpenContextMenu(&application.ContextMenuData{Id: contextMenuName, X: req.X, Y: req.Y, Data: req.Corr})
		})
		w.WriteHeader(http.StatusNoContent)
	}
}
