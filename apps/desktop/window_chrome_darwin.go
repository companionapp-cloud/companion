//go:build darwin

package main

// Where the traffic lights sit. The main window uses a transparent, hidden-inset titlebar
// (main.go), so the page draws under the close/minimise/zoom buttons and has to keep its
// own chrome clear of them. Their position isn't a constant: macOS 26 draws them larger and
// lower than earlier releases, so we measure the real buttons instead of guessing.

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>

// Bounding box of the standard window buttons, in CSS px from the content view's top-left
// (the web page's coordinate space). Returns 0 when the window has no such buttons.
static int windowControlsFrame(void *ptr, double *left, double *top, double *bottom) {
	NSWindow *w = (NSWindow *)ptr;
	NSButton *close = [w standardWindowButton:NSWindowCloseButton];
	NSButton *zoom = [w standardWindowButton:NSWindowZoomButton];
	NSView *content = w.contentView;
	if (close == nil || zoom == nil || close.superview == nil || content == nil) {
		return 0;
	}
	// Window (base) coordinates: origin bottom-left, y up.
	NSRect c = [close.superview convertRect:close.frame toView:nil];
	NSRect z = [zoom.superview convertRect:zoom.frame toView:nil];
	NSRect page = [content convertRect:content.bounds toView:nil];
	*left = NSMaxX(z) - NSMinX(page);
	*top = NSMaxY(page) - NSMaxY(c);
	*bottom = NSMaxY(page) - NSMinY(c);
	return 1;
}
*/
import "C"

import (
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// measureWindowControls reports the box the native window buttons occupy over the page.
// Safe from any goroutine — the AppKit calls run on the main thread.
func measureWindowControls(win *application.WebviewWindow) (windowControls, bool) {
	if win == nil {
		return windowControls{}, false
	}
	ptr := win.NativeWindow()
	if ptr == nil {
		return windowControls{}, false
	}
	return application.InvokeSyncWithResultAndOther(func() (windowControls, bool) {
		var left, top, bottom C.double
		if C.windowControlsFrame(unsafe.Pointer(ptr), &left, &top, &bottom) == 0 {
			return windowControls{}, false
		}
		return windowControls{Left: float64(left), Top: float64(top), Bottom: float64(bottom)}, true
	})
}
