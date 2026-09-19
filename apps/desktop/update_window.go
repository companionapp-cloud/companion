package main

// The updater window. Forced updates (updates.go) install in a window of their own, which
// stands in for the app until Companion restarts into the new version:
//
//   - A launch shows nothing until the first update check answers. An update opens the
//     updater window instead of the main window; no update, no network, or no answer within
//     bootCheckWait shows the main window.
//   - An update found mid-session hides the app's windows (the main window and pop-outs) and
//     opens the updater window in their place, without pulling Companion in front of another
//     app. With nothing of Companion on screen, it installs out of sight.
//   - Meanwhile every way of opening Companion — the menu bar, the Dock, launching it again, a
//     notification — shows the updater window.
//   - A failed update says why in the updater window. Continue, or its close button (disabled
//     while an update installs), gives the app back; a failure that's been dismissed doesn't
//     reopen the window by itself.
//
// The window loads frontend/updater.html, which follows the update through GET /update and the
// "update:state" event, and fits the window to what it shows.

import (
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

const (
	updaterWindowName = "updater"
	// The updater window opens at the size of its progress view; its page then fits the height
	// to what it shows. Wide enough for the Homebrew command on one line.
	updaterWidth  = 480
	updaterHeight = 164
)

// updateWindows is what the update flow needs from Companion's windows. updaterWindows does it
// with Wails; tests fake it. "On screen" means shown, even behind other windows or on a sleeping
// display (windowShown): whether the window could be used, not whether it's in view.
type updateWindows interface {
	// openUpdater opens the updater window or brings it forward. focus activates Companion too,
	// for when someone asked; otherwise it doesn't pull Companion in front of another app.
	openUpdater(focus bool)
	// closeUpdater closes the updater window, if it's open.
	closeUpdater()
	// showMain shows the main window and brings Companion forward.
	showMain()
	// holdApp hides the app's windows that are on screen and reports whether there were any.
	holdApp() bool
	// releaseApp shows the windows holdApp hid again, and the main window when main is set.
	releaseApp(main bool)
	// appVisible reports whether any of the app's windows is on screen.
	appVisible() bool
}

// --- what's on screen ---

// openApp is every way of opening Companion: the menu bar, the Dock, launching it again, a
// notification. It shows the main window, or the updater window while that has the app.
func (s *updateService) openApp() {
	s.winMu.Lock()
	defer s.winMu.Unlock()
	if s.windows == nil {
		return // not attached yet
	}
	s.wantMain = true
	switch {
	case s.launching:
		// The first check decides which, in a moment.
	case s.held:
		s.openUpdaterLocked(true)
	default:
		s.windows.showMain()
	}
}

// endLaunch shows the app if the launch is still waiting on the first check: it failed, found
// nothing, or is taking too long.
func (s *updateService) endLaunch() {
	s.winMu.Lock()
	defer s.winMu.Unlock()
	if s.launching {
		s.launching = false
		s.releaseLocked()
	}
}

// upToDate: a check found nothing to install. The launch goes ahead, and a failure the updater
// window is still showing no longer applies.
func (s *updateService) upToDate() {
	s.winMu.Lock()
	defer s.winMu.Unlock()
	switch {
	case s.launching || s.held:
		s.launching = false
		s.releaseLocked()
	case s.updaterOpen:
		// A failure shown over the app, which never hid anything.
		s.updaterOpen = false
		s.windows.closeUpdater()
	}
}

// takeOver puts the updater window in the app's place while an update installs. At launch it
// opens instead of the main window. Later it hides the app's windows and opens where they were,
// without pulling Companion in front of another app. With nothing of Companion on screen the
// update installs out of sight, unless someone asked for it.
func (s *updateService) takeOver(asked bool) {
	s.winMu.Lock()
	defer s.winMu.Unlock()
	switch {
	case s.launching:
		s.launching = false // held since launch, with nothing on screen yet
	case !s.held:
		s.held, s.wantMain = true, false
		s.heldApp = s.windows.holdApp()
	}
	if asked {
		s.wantMain = true
	}
	if s.wantMain || s.heldApp {
		s.openUpdaterLocked(asked)
	}
}

// failed shows why an update didn't install: in the updater window if it's open or has the
// app, over the app if that's on screen, and otherwise the next time Companion is opened. A
// failure that's been dismissed doesn't come back by itself; a check the user asked for does.
func (s *updateService) failed(st updateState, asked bool) {
	s.winMu.Lock()
	defer s.winMu.Unlock()
	s.launching = false
	switch {
	case s.updaterOpen:
		// It shows the failure now.
	case asked:
		s.held, s.wantMain = true, true
		s.openUpdaterLocked(true)
	case failureKey(st) == s.dismissed:
		if s.held {
			s.releaseLocked()
		}
	case s.held:
		if s.wantMain || s.heldApp {
			s.openUpdaterLocked(false)
		}
	case s.windows.appVisible():
		// It can't replace itself where it's installed, which a check finds before hiding
		// anything: say so over the app.
		s.openUpdaterLocked(false)
	default:
		s.held, s.wantMain = true, false
	}
}

// updaterClosed: the user closed the updater window, with Continue or its close button (which
// only works once nothing's installing). That dismisses the failure it showed and gives the app
// back.
func (s *updateService) updaterClosed() {
	s.winMu.Lock()
	defer s.winMu.Unlock()
	s.updaterOpen = false
	if st := s.snapshot(); st.Phase == updateFailed {
		s.dismissed = failureKey(st)
	}
	if s.held {
		s.releaseLocked()
	}
}

// relaunchHidden reports whether the version an update restarts into should start in the menu
// bar: nothing of Companion was on screen when the update took over, and nobody opened it since.
func (s *updateService) relaunchHidden() bool {
	s.winMu.Lock()
	defer s.winMu.Unlock()
	return !s.wantMain && !s.heldApp
}

// releaseLocked lets the app go: the updater window closes, and the windows it held come back,
// with the main window if it's wanted.
func (s *updateService) releaseLocked() {
	s.held, s.heldApp, s.updaterOpen = false, false, false
	s.windows.closeUpdater()
	s.windows.releaseApp(s.wantMain)
}

func (s *updateService) openUpdaterLocked(focus bool) {
	s.updaterOpen = true
	s.windows.openUpdater(focus)
}

// failureKey tells failures apart for dismissing them: the same error for the same version.
func failureKey(st updateState) string { return st.Version + "\n" + st.Error }

// --- the windows, in Wails ---

// updaterWindows is updateWindows over Wails.
type updaterWindows struct {
	app  *application.App
	main *application.WebviewWindow
	// state is the update's current state; closed is told when the user closes the updater
	// window.
	state  func() updateState
	closed func()

	mu          sync.Mutex
	updater     *application.WebviewWindow
	closeButton application.ButtonState
	held        []application.Window
}

func newUpdaterWindows(app *application.App, main *application.WebviewWindow, state func() updateState, closed func()) *updaterWindows {
	return &updaterWindows{app: app, main: main, state: state, closed: closed}
}

func (w *updaterWindows) openUpdater(focus bool) {
	w.mu.Lock()
	win := w.updater
	w.mu.Unlock()
	if win == nil {
		win = w.newUpdaterWindow() // shows itself once its page has loaded
	} else {
		if win.IsMinimised() {
			win.UnMinimise()
		}
		win.Show()
	}
	if focus {
		win.Focus()
	}
}

func (w *updaterWindows) newUpdaterWindow() *application.WebviewWindow {
	button := closeButtonFor(w.state().Phase)
	win := w.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:                updaterWindowName,
		Title:               "Updating Companion",
		Width:               updaterWidth,
		Height:              updaterHeight,
		DisableResize:       true,
		MaximiseButtonState: application.ButtonDisabled,
		CloseButtonState:    button,
		InitialPosition:     application.WindowCentered,
		BackgroundColour:    application.NewRGB(245, 245, 243),
		URL:                 "/updater.html",
		Mac: application.MacWindow{
			// Transparent titlebar: the page draws the whole window, below the traffic lights.
			TitleBar: application.MacTitleBarHidden,
		},
	})
	// Wails opens it a fraction of a point smaller than asked; the page keeps the width it finds
	// when it fits the height (updater.tsx), so make it exact first.
	win.SetSize(updaterWidth, updaterHeight)
	w.mu.Lock()
	w.updater, w.closeButton = win, button
	w.mu.Unlock()
	// Closing the window dismisses a failure, so it can't close while an update installs: the
	// button is disabled then, and this catches ⌘W. closeUpdater lets go of the window before
	// closing it, so our own close always goes through.
	win.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		w.mu.Lock()
		current := w.updater == win
		w.mu.Unlock()
		if current && w.state().Phase.blocking() {
			e.Cancel()
		}
	})
	win.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) {
		w.mu.Lock()
		byUser := w.updater == win
		if byUser {
			w.updater = nil
		}
		w.mu.Unlock()
		if byUser {
			w.closed()
		}
	})
	return win
}

func (w *updaterWindows) closeUpdater() {
	w.mu.Lock()
	win := w.updater
	w.updater = nil
	w.mu.Unlock()
	if win != nil {
		win.Close()
	}
}

// stateChanged keeps the updater window's close button in step with the update: disabled while
// it installs, enabled once there's a failure to dismiss.
func (w *updaterWindows) stateChanged(st updateState) {
	button := closeButtonFor(st.Phase)
	w.mu.Lock()
	win := w.updater
	changed := win != nil && button != w.closeButton
	w.closeButton = button
	w.mu.Unlock()
	if changed {
		win.SetCloseButtonState(button)
	}
}

func closeButtonFor(p updatePhase) application.ButtonState {
	if p.blocking() {
		return application.ButtonDisabled
	}
	return application.ButtonEnabled
}

func (w *updaterWindows) showMain() {
	w.main.Show()
	w.main.Focus()
}

func (w *updaterWindows) holdApp() bool {
	var hid []application.Window
	for _, win := range w.appWindows() {
		if windowShown(win) {
			win.Hide()
			hid = append(hid, win)
		}
	}
	w.mu.Lock()
	w.held = append(w.held, hid...)
	w.mu.Unlock()
	return len(hid) > 0
}

func (w *updaterWindows) releaseApp(main bool) {
	w.mu.Lock()
	held := w.held
	w.held = nil
	w.mu.Unlock()
	// The main window goes last, so it ends up in front.
	for _, win := range held {
		if win.Name() == w.main.Name() {
			main = true
			continue
		}
		win.Show()
	}
	if main {
		w.main.Show()
	}
}

func (w *updaterWindows) appVisible() bool {
	for _, win := range w.appWindows() {
		if windowShown(win) {
			return true
		}
	}
	return false
}

// appWindows are the windows the updater window stands in for: the main window and pop-outs.
// Quick capture isn't one — it's a moment's note, and it closes with the rest when Companion
// restarts.
func (w *updaterWindows) appWindows() []application.Window {
	var out []application.Window
	for _, win := range w.app.Window.GetAll() {
		if name := win.Name(); name != updaterWindowName && name != captureWindowName {
			out = append(out, win)
		}
	}
	return out
}
