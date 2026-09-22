package main

import "github.com/wailsapp/wails/v3/pkg/application"

// tabCloseEvent asks the main window to close its active tab (packages/app/src/tabClose.ts). It
// travels the core's event stream, like capture.new. Once only the one empty tab is left, the
// app closes the window itself, which the main window's WindowClosing hook turns into a hide.
const tabCloseEvent = "tab.close"

// closeTabOrWindow is File › Close Tab (⌘W). In the main window it closes the active tab (the
// app decides when that means the window); any other window — a focus-mode pop-out, the
// capture palette — has no tabs, so it closes. With no window focused it does nothing.
func closeTabOrWindow(current, main application.Window, closeTab func()) {
	if current == nil {
		return
	}
	if main != nil && current.ID() == main.ID() {
		closeTab()
		return
	}
	current.Close()
}
