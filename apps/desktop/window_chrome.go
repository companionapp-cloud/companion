package main

import (
	"encoding/json"
	"net/http"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// windowControls is the box the native window buttons (macOS traffic lights) occupy over
// the page, in CSS px from the window's top-left. The frontend keeps its rail and toolbar
// clear of it (packages/app AppShell) — see window_chrome_darwin.go for the measurement.
type windowControls struct {
	Left   float64 `json:"left"`
	Top    float64 `json:"top"`
	Bottom float64 `json:"bottom"`
}

// windowChromeHandler serves GET /chrome: the window-controls box as JSON, or 204 when the
// platform draws nothing over the page. `window` is resolved per request because the main
// window is created after the asset handler is built.
func windowChromeHandler(window func() *application.WebviewWindow) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		controls, ok := measureWindowControls(window())
		if !ok {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(controls)
	}
}
