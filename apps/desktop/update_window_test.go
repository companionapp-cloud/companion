package main

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// fakeWindows models Companion's windows as the update flow sees them: the main window,
// pop-outs, and the updater window.
type fakeWindows struct {
	mu sync.Mutex
	on screen
	// What holdApp hid.
	heldMain    bool
	heldPopouts int
	// mainShown counts the main window being put on screen; opened counts openUpdater.
	mainShown, opened int
}

// screen is what's on screen.
type screen struct {
	Main    bool // the main window
	Popouts int  // pop-out windows
	Updater bool // the updater window
	Focused bool // the updater window was brought forward with focus
}

func (f *fakeWindows) screen() screen {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.on
}

func (f *fakeWindows) openUpdater(focus bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.on.Updater, f.on.Focused = true, focus
	f.opened++
}

func (f *fakeWindows) closeUpdater() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.on.Updater, f.on.Focused = false, false
}

func (f *fakeWindows) showMain() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.on.Main = true
	f.mainShown++
}

func (f *fakeWindows) holdApp() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	hid := f.on.Main || f.on.Popouts > 0
	f.heldMain = f.heldMain || f.on.Main
	f.heldPopouts += f.on.Popouts
	f.on.Main, f.on.Popouts = false, 0
	return hid
}

func (f *fakeWindows) releaseApp(main bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if main || f.heldMain {
		f.on.Main = true
		f.mainShown++
	}
	f.on.Popouts += f.heldPopouts
	f.heldMain, f.heldPopouts = false, 0
}

func (f *fakeWindows) appVisible() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.on.Main || f.on.Popouts > 0
}

// dismiss is the user closing the updater window: Continue, or its close button.
func (f *fakeWindows) dismiss(s *updateService) {
	f.mu.Lock()
	f.on.Updater, f.on.Focused = false, false
	f.mu.Unlock()
	s.updaterClosed()
}

// launching returns a service as attach leaves it at launch: nothing on screen yet, waiting on
// the first check. showMain is false for a launch that stays in the menu bar (an update restart
// while Companion was closed to it).
func launching(eng *fakeEngine, showMain bool) (*updateService, *fakeWindows) {
	s, _ := testUpdateService(eng)
	s.launching, s.held, s.wantMain = true, true, showMain
	return s, s.windows.(*fakeWindows)
}

// midSession returns a service past its launch, with on on screen.
func midSession(eng *fakeEngine, on screen) (*updateService, *fakeWindows) {
	s, _ := testUpdateService(eng)
	w := s.windows.(*fakeWindows)
	w.on = on
	return s, w
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

// --- launch ---

func TestLaunchShowsTheMainWindowWithoutAnUpdate(t *testing.T) {
	cases := map[string]*fakeEngine{
		"up to date":   {},
		"check failed": {checkErr: errors.New("dial tcp: lookup api.github.com: no such host")},
	}
	for name, eng := range cases {
		t.Run(name, func(t *testing.T) {
			s, w := launching(eng, true)
			s.run(context.Background(), false)
			if got := w.screen(); got != (screen{Main: true}) {
				t.Fatalf("screen = %+v, want the main window", got)
			}
		})
	}
}

func TestLaunchInTheMenuBarStaysThere(t *testing.T) {
	s, w := launching(&fakeEngine{}, false)
	s.run(context.Background(), false)
	if got := w.screen(); got != (screen{}) {
		t.Fatalf("screen = %+v, want nothing: this launch stays in the menu bar", got)
	}
}

func TestLaunchOpensTheUpdaterWindowInsteadOfTheMainWindow(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "relaunch-hidden")
	eng := &fakeEngine{rel: newRelease070(), staged: stagedUpdate(t)}
	s, w := launching(eng, true)
	s.markerPath = marker

	s.run(context.Background(), false)

	if eng.restarts != 1 {
		t.Fatalf("Restart called %d times, want 1", eng.restarts)
	}
	if got := w.screen(); got != (screen{Updater: true}) || w.mainShown != 0 {
		t.Fatalf("screen = %+v (main window shown %d times), want only the updater window", got, w.mainShown)
	}
	if consumeRelaunchMarker(marker) {
		t.Fatal("the new version would start in the menu bar, want its main window")
	}
}

func TestLaunchInTheMenuBarUpdatesOutOfSight(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "relaunch-hidden")
	eng := &fakeEngine{rel: newRelease070(), staged: stagedUpdate(t)}
	s, w := launching(eng, false)
	s.markerPath = marker

	s.run(context.Background(), false)

	if got := w.screen(); got != (screen{}) || w.opened != 0 {
		t.Fatalf("screen = %+v (updater opened %d times), want nothing on screen", got, w.opened)
	}
	if !consumeRelaunchMarker(marker) {
		t.Fatal("the new version would open its main window, want it to stay in the menu bar")
	}
}

func TestLaunchContinuesIntoCompanionAfterAFailedUpdate(t *testing.T) {
	eng := &fakeEngine{rel: newRelease070(), installErr: errors.New("github: download stalled (no data for 1m0s)")}
	s, w := launching(eng, true)

	s.run(context.Background(), false)
	if got := w.screen(); got != (screen{Updater: true}) {
		t.Fatalf("screen = %+v, want the failure in the updater window", got)
	}
	w.dismiss(s)
	if got := w.screen(); got != (screen{Main: true}) {
		t.Fatalf("screen = %+v after Continue, want the main window", got)
	}
}

func TestLaunchDoesNotWaitLongOnTheCheck(t *testing.T) {
	eng := &fakeEngine{gate: make(chan struct{})}
	s, w := launching(eng, true)
	s.launchWait = 10 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.boot(ctx)

	waitFor(t, "the main window", func() bool { return w.screen().Main })

	// The check answers late, with an update: the updater window takes the main window's place.
	eng.mu.Lock()
	eng.rel, eng.staged = newRelease070(), stagedUpdate(t)
	eng.mu.Unlock()
	close(eng.gate)
	waitFor(t, "the restart", func() bool { return eng.restarted() == 1 })
	if got := w.screen(); got != (screen{Updater: true}) {
		t.Fatalf("screen = %+v, want the updater window in the main window's place", got)
	}
}

func TestOpeningCompanionDuringTheLaunchCheckWaitsForIt(t *testing.T) {
	eng := &fakeEngine{gate: make(chan struct{})}
	s, w := launching(eng, false)
	done := make(chan struct{})
	go func() {
		s.run(context.Background(), false)
		close(done)
	}()
	waitFor(t, "the check", func() bool {
		eng.mu.Lock()
		defer eng.mu.Unlock()
		return eng.checks == 1
	})

	s.openApp()
	if got := w.screen(); got != (screen{}) {
		t.Fatalf("screen = %+v while the launch check runs, want nothing yet", got)
	}
	close(eng.gate)
	<-done
	if got := w.screen(); got != (screen{Main: true}) {
		t.Fatalf("screen = %+v, want the main window that was asked for", got)
	}
}

// --- mid-session ---

func TestUpdateTakesTheAppsPlace(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "relaunch-hidden")
	eng := &fakeEngine{rel: newRelease070(), staged: stagedUpdate(t)}
	s, w := midSession(eng, screen{Main: true, Popouts: 1})
	s.markerPath = marker

	s.run(context.Background(), false)

	// Unfocused: a background check doesn't pull Companion in front of another app.
	if got := w.screen(); got != (screen{Updater: true}) {
		t.Fatalf("screen = %+v, want the updater window in place of the app's windows", got)
	}
	if consumeRelaunchMarker(marker) {
		t.Fatal("the new version would start in the menu bar, but Companion was on screen")
	}
}

func TestAFailedUpdateGivesTheAppBack(t *testing.T) {
	eng := &fakeEngine{rel: newRelease070(), installErr: errors.New("updater: digest mismatch")}
	s, w := midSession(eng, screen{Main: true, Popouts: 1})

	s.run(context.Background(), false)
	if got := w.screen(); got != (screen{Updater: true}) {
		t.Fatalf("screen = %+v, want the failure in the updater window", got)
	}
	w.dismiss(s)
	if got := w.screen(); got != (screen{Main: true, Popouts: 1}) {
		t.Fatalf("screen = %+v after Continue, want the app's windows back", got)
	}
}

func TestOpeningCompanionMidUpdateShowsTheUpdaterWindow(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "relaunch-hidden")
	eng := &fakeEngine{rel: newRelease070(), staged: stagedUpdate(t)}
	s, w := midSession(eng, screen{}) // closed to the menu bar
	s.markerPath = marker
	var during screen
	eng.during = func() {
		s.openApp()
		during = w.screen()
	}

	s.run(context.Background(), false)

	if during != (screen{Updater: true, Focused: true}) {
		t.Fatalf("opening Companion mid-update showed %+v, want the updater window, focused", during)
	}
	if consumeRelaunchMarker(marker) {
		t.Fatal("the new version would start in the menu bar, but Companion was opened during the update")
	}
}

func TestAFailureOutOfSightWaitsForCompanionToOpen(t *testing.T) {
	eng := &fakeEngine{rel: newRelease070()}
	s, w := midSession(eng, screen{})
	s.replaceable = func(string) error { return errors.New("no write access to /Applications") }

	s.run(context.Background(), false)
	if got := w.screen(); got != (screen{}) {
		t.Fatalf("screen = %+v, want nothing while Companion is in the menu bar", got)
	}
	s.openApp()
	if got := w.screen(); got != (screen{Updater: true, Focused: true}) {
		t.Fatalf("screen = %+v on opening Companion, want the failure first", got)
	}
	w.dismiss(s)
	if got := w.screen(); got != (screen{Main: true}) {
		t.Fatalf("screen = %+v after Continue, want the main window", got)
	}
}

func TestADismissedFailureStaysDismissed(t *testing.T) {
	eng := &fakeEngine{rel: newRelease070()}
	s, w := midSession(eng, screen{Main: true})
	s.replaceable = func(string) error { return errors.New("no write access to /Applications") }

	s.run(context.Background(), false)
	if got := w.screen(); got != (screen{Main: true, Updater: true}) {
		t.Fatalf("screen = %+v, want the failure over the app", got)
	}
	w.dismiss(s)
	s.run(context.Background(), false) // the next check fails the same way
	if got := w.screen(); got != (screen{Main: true}) || w.opened != 1 {
		t.Fatalf("screen = %+v (updater opened %d times), want the dismissed failure to stay dismissed", got, w.opened)
	}
	s.run(context.Background(), true) // unless someone asks
	if got := w.screen(); !got.Updater || !got.Focused {
		t.Fatalf("screen = %+v, want a manual check to show the failure again", got)
	}
}

func TestAnUpToDateCheckClosesAFailureThatNoLongerApplies(t *testing.T) {
	eng := &fakeEngine{rel: newRelease070(), installErr: errors.New("updater: digest mismatch")}
	s, w := midSession(eng, screen{Main: true})
	s.run(context.Background(), false)

	eng.mu.Lock()
	eng.rel = nil // the release was pulled
	eng.mu.Unlock()
	s.run(context.Background(), false)

	if got := w.screen(); got != (screen{Main: true}) {
		t.Fatalf("screen = %+v, want the app back without the stale failure", got)
	}
}
