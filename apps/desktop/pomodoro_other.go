//go:build !darwin

package main

import "github.com/wailsapp/wails/v3/pkg/application"

// The panel treatment is macOS-specific (see pomodoro_darwin.go); elsewhere the timer is a
// plain frameless window that Wails shows and focuses.
func preparePomodoroPanel(*application.WebviewWindow) {}

// Elsewhere the page draws its modules itself.
func setPomodoroGlass(win *application.WebviewWindow, height float64, _ []pomodoroGlassRect) {
	if height > 0 {
		win.SetSize(pomodoroWindowWidth, int(height))
	}
}

func presentPomodoroPanel(win *application.WebviewWindow) {
	win.Show()
	win.Focus()
}
