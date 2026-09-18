//go:build !darwin

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// measureWindowControls: only macOS draws the page under its window buttons (see
// window_chrome_darwin.go). Windows/Linux keep a native titlebar above the webview.
func measureWindowControls(_ *application.WebviewWindow) (windowControls, bool) {
	return windowControls{}, false
}
