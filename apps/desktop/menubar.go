package main

import (
	_ "embed"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// trayIconTemplate is the Companion "C" mark on a transparent background (no orange
// square). It is set as a macOS *template* image so the OS tints it to match the menu
// bar in light/dark mode. Source: the exported icon's monochrome variant, cropped tight.
//
//go:embed assets/trayTemplate.png
var trayIconTemplate []byte

// installMenuBar adds the Companion system-tray item (PLAN §6.4: "ship a launch at
// login / run in menu bar option"). It is what keeps reminders reachable once the main
// window is closed to the menu bar: a way to reopen the window, toggle launch-at-login,
// and actually quit.
//
// Launch-at-login uses Wails' Autostart manager (SMAppService on macOS 13+ from a
// bundled .app, a LaunchAgent plist otherwise). Like notifications, it is a no-op from
// an unbundled dev build.
//
// openWindow brings Companion up: the main window, or the updater window while an update has
// the app (update_window.go). checkForUpdates, when non-nil (release builds, see updates.go),
// adds "Check for Updates…".
//
// A click brings up the menu bar panel (pomodoro.go); with the pomodoro tool on, the item also
// shows the countdown while a pomodoro or its break runs. The menu is a right-click away.
func installMenuBar(app *application.App, openWindow func(), checkForUpdates func(), pomodoro *pomodoroTimer) *application.SystemTray {
	tray := app.SystemTray.New()
	// Just the icon in the menu bar — a template image, no text label. macOS auto-sizes
	// it to the menu-bar thickness and recolours it for light/dark appearance.
	tray.SetTemplateIcon(trayIconTemplate)
	tray.SetTooltip("Companion")

	// A click drops the Control Center–style panel down (or puts it away): the pomodoro timer
	// when that tool is on, a compact layout when it's off, quick capture in both. A right-click
	// opens this menu.
	tray.OnClick(pomodoro.toggleWindow)

	menu := app.NewMenu()
	menu.Add("Open Companion").OnClick(func(*application.Context) { openWindow() })
	// Only while the pomodoro tool is switched on (pomodoro.go keeps it in step).
	pomodoro.attachMenu(menu, menu.Add("Pomodoro Timer").OnClick(func(*application.Context) { pomodoro.showWindow() }))
	if checkForUpdates != nil {
		menu.Add("Check for Updates…").OnClick(func(*application.Context) { checkForUpdates() })
	}
	menu.AddSeparator()

	// Reflect the current registration on first paint; toggling flips it and updates the
	// checkmark. Enable/Disable take effect on the *next* login, per the manager's docs.
	launchAtLogin := menu.AddCheckbox("Launch at Login", false)
	if enabled, err := app.Autostart.IsEnabled(); err == nil {
		launchAtLogin.SetChecked(enabled)
	}
	launchAtLogin.OnClick(func(ctx *application.Context) {
		// The checkbox has already toggled; ctx.IsChecked() is the requested new state.
		var err error
		if ctx.IsChecked() {
			err = app.Autostart.Enable()
		} else {
			err = app.Autostart.Disable()
		}
		if err != nil {
			// Registration failed (e.g. unbundled dev build): revert the checkmark so it
			// keeps reflecting reality rather than the attempted state.
			launchAtLogin.SetChecked(!ctx.IsChecked())
			menu.Update()
		}
	})

	menu.AddSeparator()
	menu.Add("Quit Companion").OnClick(func(*application.Context) { app.Quit() })

	tray.SetMenu(menu)
	return tray
}
