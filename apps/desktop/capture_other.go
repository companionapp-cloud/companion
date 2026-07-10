//go:build !darwin

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// presentCapturePanel shows the capture window. The non-activating-panel treatment is
// macOS-specific (see capture_darwin.go); on Windows/Linux we fall back to Wails' show + focus.
func presentCapturePanel(win *application.WebviewWindow) {
	if win == nil {
		return
	}
	win.Show()
	win.Focus()
}
