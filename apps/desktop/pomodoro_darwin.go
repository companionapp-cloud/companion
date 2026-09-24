//go:build darwin

package main

// Control Center–style presentation for the pomodoro timer on macOS.
//
// The panel should feel like a menu bar extra, not an app window: a glass panel that drops out
// of its menu bar item, floats over everything (full-screen apps and every Space included) and
// never pulls Companion forward — no Dock bounce, no main window. Like quick capture
// (capture_darwin.go), that takes a non-activating NSPanel: the Wails window is reclassed to a
// panel subclass with WebviewWindow's ivar layout, so Wails' own native code keeps working.
// There is no panel behind the modules, as there isn't in Control Center: the window is fully
// transparent and each module is its own piece of Liquid Glass. The page reports where its modules
// are (POST /pomodoro/glass) and a native NSGlassEffectView (a vibrancy view before macOS 26) is
// placed under each, shaped to it, beneath the transparent webview.

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

// Same ivar layout as Wails' WebviewWindow, rooted at NSPanel (see capture_darwin.go).
@interface CompanionPomodoroPanel : NSPanel
@property (assign) WKWebView* webView;
@property BOOL disableEscapeExitsFullscreen;
@end

@implementation CompanionPomodoroPanel
- (BOOL)canBecomeKeyWindow { return YES; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

// preparePomodoroPanel turns the window into the panel, once. It must run before anything
// observes the window: key-value observing works by swapping the window's class for a generated
// subclass, and swapping it again underneath would lose that bookkeeping — the glass views
// observe the window's "opaque", and removing them later then throws (NSRangeException) and takes
// the app down. So setPomodoroGlass calls this before it adds any glass, and a window that is
// already observed is left as a plain window rather than reclassed.
static void preparePomodoroPanel(void *ptr) {
	NSWindow *w = (NSWindow *)ptr;
	if ([w isKindOfClass:[CompanionPomodoroPanel class]]) return;
	if (object_getClass(w) != [w class]) {
		// KVO's subclass reports the original class from -class; the real one differs.
		NSLog(@"pomodoro: panel window is already observed; leaving it a plain window");
		return;
	}
	object_setClass(w, [CompanionPomodoroPanel class]);
	NSPanel *p = (NSPanel *)w;
	[p setStyleMask:(NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel)];
	[p setFloatingPanel:YES];
	// Key, so Esc and the buttons answer straight away — and so it can tell when the user
	// clicks elsewhere (it resigns key) and put itself away, like Control Center.
	[p setBecomesKeyOnlyIfNeeded:NO];
	[p setHidesOnDeactivate:NO];
	// Wails owns the window's lifecycle (see capture_darwin.go).
	[p setReleasedWhenClosed:NO];
	[p setOpaque:NO];
	[p setBackgroundColor:[NSColor clearColor]];
	// No window shadow: there's no panel to cast one — the glass modules carry their own.
	[p setHasShadow:NO];
	[p setMovable:NO];
	[p setLevel:NSPopUpMenuWindowLevel];
	[p setCollectionBehavior:NSWindowCollectionBehaviorCanJoinAllSpaces
		| NSWindowCollectionBehaviorFullScreenAuxiliary
		| NSWindowCollectionBehaviorTransient
		| NSWindowCollectionBehaviorIgnoresCycle];
}

static void showPomodoroPanel(void *ptr) {
	NSWindow *w = (NSWindow *)ptr;
	[w orderFrontRegardless];
	[w makeKeyWindow];
}

static NSString *const glassID = @"companion.pomodoro.glass";

// A light touch of shade on top of the dark glass, so white type holds up over bright windows.
static NSColor *glassTint(void) { return [NSColor colorWithWhite:0 alpha:0.12]; }

// The glass is dark glass, whatever the system appearance: the modules carry white type, and
// glass left to follow a light-mode appearance renders frosted white — Control Center's reads
// dark over the desktop and windows it's usually opened over.
static NSAppearance *glassAppearance(void) { return [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua]; }

// setPomodoroGlass fits the panel to the page's layout and replaces the glass under its modules.
// panelHeight is the height the layout needs (0 keeps the current one), held at the top edge so
// the panel still hangs from the menu bar. rects holds n records of {x, y, width, height,
// cornerRadius} in the page's coordinates (points, origin top-left).
static void setPomodoroGlass(void *ptr, double panelHeight, const double *rects, int n) {
	NSWindow *w = (NSWindow *)ptr;
	// Before any glass exists to observe the window (see preparePomodoroPanel).
	preparePomodoroPanel(ptr);
	if (panelHeight > 0 && fabs(w.frame.size.height - panelHeight) >= 1) {
		NSRect f = w.frame;
		f.origin.y += f.size.height - panelHeight;
		f.size.height = panelHeight;
		[w setFrame:f display:YES];
	}
	NSView *content = [w contentView];
	// Frameless Wails windows round the content view; the modules do their own rounding.
	if (content.layer) content.layer.cornerRadius = 0;
	NSView *web = nil;
	for (NSView *v in [NSArray arrayWithArray:[content subviews]]) {
		if ([v isKindOfClass:[WKWebView class]]) web = v;
		else if ([v.identifier isEqualToString:glassID]) [v removeFromSuperview];
	}
	CGFloat height = content.bounds.size.height;
	// The panel (and the webview in it) take the dark appearance too, so everything on it —
	// including the glass's own edge highlights — is drawn for dark.
	[w setAppearance:glassAppearance()];

	// macOS 26: every module is an NSGlassEffectView inside one NSGlassEffectContainerView, so
	// they render as one family of glass — same sampling, same thickness — the way Control
	// Center's modules do. On their own each piece picks its look from its size and what's
	// behind it, and the big timer tile came out frosted white beside dark capsules. Spacing 0
	// keeps the pieces from melting into each other.
	Class glassClass = nil, containerClass = nil;
	if (@available(macOS 26.0, *)) {
		glassClass = NSClassFromString(@"NSGlassEffectView");
		containerClass = NSClassFromString(@"NSGlassEffectContainerView");
	}
	NSView *host = content;
	NSView *container = nil;
	if (glassClass && containerClass) {
		container = [[[containerClass alloc] initWithFrame:content.bounds] autorelease];
		[container setAutoresizingMask:NSViewWidthSizable | NSViewHeightSizable];
		[container setValue:@0 forKey:@"spacing"];
		[container setAppearance:glassAppearance()];
		NSView *inner = [[[NSView alloc] initWithFrame:content.bounds] autorelease];
		[inner setAutoresizingMask:NSViewWidthSizable | NSViewHeightSizable];
		[container setValue:inner forKey:@"contentView"];
		host = inner;
	}

	for (int i = 0; i < n; i++) {
		const double *r = rects + i * 5;
		// AppKit's origin is bottom-left.
		NSRect frame = NSMakeRect(r[0], height - r[1] - r[3], r[2], r[3]);
		NSView *glass;
		if (glassClass) {
			glass = [[[glassClass alloc] initWithFrame:frame] autorelease];
			[glass setValue:@(r[4]) forKey:@"cornerRadius"];
			[glass setValue:glassTint() forKey:@"tintColor"];
			[glass setAppearance:glassAppearance()];
		} else {
			NSVisualEffectView *fx = [[[NSVisualEffectView alloc] initWithFrame:frame] autorelease];
			[fx setMaterial:NSVisualEffectMaterialHUDWindow];
			[fx setAppearance:glassAppearance()];
			[fx setBlendingMode:NSVisualEffectBlendingModeBehindWindow];
			[fx setState:NSVisualEffectStateActive];
			[fx setWantsLayer:YES];
			fx.layer.cornerRadius = r[4];
			fx.layer.masksToBounds = YES;
			glass = fx;
		}
		if (container) {
			[host addSubview:glass];
		} else {
			glass.identifier = glassID;
			if (web) [content addSubview:glass positioned:NSWindowBelow relativeTo:web];
			else [content addSubview:glass positioned:NSWindowBelow relativeTo:nil];
		}
	}
	if (container) {
		container.identifier = glassID;
		if (web) [content addSubview:container positioned:NSWindowBelow relativeTo:web];
		else [content addSubview:container positioned:NSWindowBelow relativeTo:nil];
	}
}
*/
import "C"

import (
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// preparePomodoroPanel turns the timer window into a non-activating floating panel (once).
func preparePomodoroPanel(win *application.WebviewWindow) {
	ptr := win.NativeWindow()
	if ptr == nil {
		return
	}
	application.InvokeSync(func() { C.preparePomodoroPanel(unsafe.Pointer(ptr)) })
}

// setPomodoroGlass puts a piece of native glass under each of the page's modules.
func setPomodoroGlass(win *application.WebviewWindow, height float64, rects []pomodoroGlassRect) {
	ptr := win.NativeWindow()
	if ptr == nil {
		return
	}
	flat := make([]C.double, 0, len(rects)*5+1)
	for _, r := range rects {
		flat = append(flat, C.double(r.X), C.double(r.Y), C.double(r.W), C.double(r.H), C.double(r.R))
	}
	flat = append(flat, 0) // never empty, so &flat[0] is valid
	application.InvokeSync(func() { C.setPomodoroGlass(unsafe.Pointer(ptr), C.double(height), &flat[0], C.int(len(rects))) })
}

// presentPomodoroPanel shows the (already positioned) panel and makes it key without
// activating Companion.
func presentPomodoroPanel(win *application.WebviewWindow) {
	ptr := win.NativeWindow()
	if ptr == nil {
		win.Show()
		return
	}
	application.InvokeSync(func() { C.showPomodoroPanel(unsafe.Pointer(ptr)) })
}
