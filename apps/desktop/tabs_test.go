package main

import (
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// fakeWindow stands in for a Wails window: only ID and Close are called.
type fakeWindow struct {
	application.Window
	id     uint
	closed bool
}

func (w *fakeWindow) ID() uint { return w.id }
func (w *fakeWindow) Close()   { w.closed = true }

func TestCloseTabOrWindow(t *testing.T) {
	main := &fakeWindow{id: 1}
	other := &fakeWindow{id: 2}

	tabs := 0
	closeTab := func() { tabs++ }

	closeTabOrWindow(main, main, closeTab)
	if tabs != 1 || main.closed {
		t.Fatalf("main window: want a tab closed and the window kept, got tabs=%d closed=%v", tabs, main.closed)
	}

	closeTabOrWindow(other, main, closeTab)
	if tabs != 1 || !other.closed {
		t.Fatalf("other window: want it closed and no tab closed, got tabs=%d closed=%v", tabs, other.closed)
	}

	closeTabOrWindow(nil, main, closeTab)
	if tabs != 1 {
		t.Fatalf("no focused window: want nothing, got tabs=%d", tabs)
	}
}
