//go:build darwin

package main

// Spotlight-style presentation for the quick-capture window on macOS.
//
// The goal: a panel that floats in over whatever you're doing, is immediately typable, and
// disturbs nothing when it opens or closes — it must NOT activate Companion (which would pull
// the Dock icon, app menu, and the main window forward) and must NOT change window focus when
// it goes away.
//
// macOS only lets a window become key (accept keystrokes) while its app is INACTIVE if that
// window is a non-activating NSPanel (NSWindowStyleMaskNonactivatingPanel). Wails creates a
// plain NSWindow subclass (WebviewWindow), so out of the box you'd have to click the panel to
// type (which activates the app), and closing it then promotes the main window.
//
// Fix: reclass the existing WebviewWindow instance to a small NSPanel subclass. NSPanel adds
// no instance variables over NSWindow, so an NSPanel subclass declaring the same ivars in the
// same order as WebviewWindow (`WKWebView *webView`, then `BOOL disableEscapeExitsFullscreen`)
// keeps those ivars at identical offsets — Wails' native code that reads `window.webView`
// (loadRequest, evaluateJavaScript, transparency, …) keeps working. We then flip on the
// non-activating panel behavior and float it in without activating the app.

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

// Same ivar layout as Wails' WebviewWindow, but rooted at NSPanel so AppKit treats it as a
// panel. The property redeclarations exist purely to reproduce `_webView` /
// `_disableEscapeExitsFullscreen` at the matching offsets for KVC + `window.webView` access.
@interface CompanionCapturePanel : NSPanel
@property (assign) WKWebView* webView;
@property BOOL disableEscapeExitsFullscreen;
@end

@implementation CompanionCapturePanel
- (BOOL)canBecomeKeyWindow { return YES; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

static void presentCapturePanel(void *ptr) {
	NSWindow *w = (NSWindow *)ptr;

	// One-time: turn the Wails window into a non-activating panel.
	if (![w isKindOfClass:[CompanionCapturePanel class]]) {
		object_setClass(w, [CompanionCapturePanel class]);
		NSPanel *p = (NSPanel *)w;
		// Set the mask explicitly (borderless + non-activating). Leaving Wails' other bits in
		// place — or OR-ing onto them — makes the panel draw a titlebar/traffic-light frame.
		[p setStyleMask:(NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel)];
		[p setTitleVisibility:NSWindowTitleHidden];
		[p setTitlebarAppearsTransparent:YES];
		// No native window shadow: it hugs the opaque card and its crisp inner rim reads as a
		// line at the rounded edge. setStyleMask above can re-enable it, so turn it off here —
		// the CaptureView card draws its own soft CSS shadow.
		[p setHasShadow:NO];
		[p setFloatingPanel:YES];
		[p setBecomesKeyOnlyIfNeeded:NO];  // become key so the capture field is typable
		[p setHidesOnDeactivate:NO];
		// Wails owns the window's lifecycle and keeps referencing it through close teardown.
		// The AppKit default (isReleasedWhenClosed=YES) frees the window on -close, so those
		// post-close accesses hit freed memory and take the whole app down. Let Wails release it.
		[p setReleasedWhenClosed:NO];
		[p setLevel:NSFloatingWindowLevel];
		[p setCollectionBehavior:NSWindowCollectionBehaviorCanJoinAllSpaces
			| NSWindowCollectionBehaviorFullScreenAuxiliary];
	}

	[w center];
	// orderFrontRegardless + makeKeyWindow on a non-activating panel shows it and gives it
	// keyboard focus WITHOUT activating Companion, so the main window is never disturbed.
	[w orderFrontRegardless];
	[w makeKeyWindow];
}
*/
import "C"

import (
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// presentCapturePanel shows the capture window as a non-activating floating panel. Safe to
// call from any goroutine — the native work is marshalled onto the main thread.
func presentCapturePanel(win *application.WebviewWindow) {
	if win == nil {
		return
	}
	ptr := win.NativeWindow()
	if ptr == nil {
		return
	}
	application.InvokeSync(func() {
		C.presentCapturePanel(unsafe.Pointer(ptr))
	})
}
