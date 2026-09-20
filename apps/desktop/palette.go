package main

import (
	"encoding/json"
	"io"
	"net/http"
)

// paletteOpenEvent tells the main window to show what the quick-capture palette picked. Like
// notify.activate it travels the core's event stream; its payload is the webview's own TabRef,
// which the Go side relays without reading (packages/app PaletteNavigationBridge consumes it).
const paletteOpenEvent = "palette.open"

// A TabRef is a few short fields; anything much larger isn't one.
const paletteOpenMaxBytes = 4 << 10

// paletteOpenHandler serves POST /palette/open. The quick-capture window is a webview of its
// own with no navigator, so when a result is chosen there it posts the ref here: surface brings
// the main window forward, and emit hands the ref to it.
func paletteOpenHandler(surface func(), emit func(name string, payload []byte)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, paletteOpenMaxBytes))
		if err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		var ref struct {
			Kind string `json:"kind"`
		}
		if err := json.Unmarshal(body, &ref); err != nil || ref.Kind == "" {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		surface()
		emit(paletteOpenEvent, body)
		w.WriteHeader(http.StatusNoContent)
	}
}
