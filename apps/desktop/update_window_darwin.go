//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>

// Whether the window is shown: ordered in, even when other windows cover it or the display
// sleeps. Minimised windows aren't.
static int windowShown(void *ptr) {
	return [(NSWindow *)ptr isVisible] ? 1 : 0;
}
*/
import "C"

import (
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// windowShown reports whether win is shown, even behind another app's windows or on a display
// that's asleep. Wails' IsVisible can't say: on macOS it reports whether any of the window can
// be seen (its occlusion state), so a main window covered by a browser counts as hidden — and
// an update would leave it open, then restart Companion into the menu bar. Safe from any
// goroutine; AppKit is asked on the main thread.
func windowShown(win application.Window) bool {
	webview, ok := win.(*application.WebviewWindow)
	if !ok {
		return win.IsVisible()
	}
	ptr := webview.NativeWindow()
	if ptr == nil {
		return false
	}
	return application.InvokeSyncWithResult(func() bool {
		return C.windowShown(unsafe.Pointer(ptr)) != 0
	})
}
