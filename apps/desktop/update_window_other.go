//go:build !darwin

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// windowShown reports whether win is shown. Only macOS's IsVisible is about occlusion instead
// (see update_window_darwin.go).
func windowShown(win application.Window) bool { return win.IsVisible() }
