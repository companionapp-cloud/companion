// Quick capture: a frameless, Spotlight-style window (desktop) holding the command palette —
// capture a task, note, canvas or event, or find something and open it in the main window. Reached
// via the `?capture=1` URL the desktop shell's global Option/Alt+Space shortcut opens
// (apps/desktop/main.go). Web/native ignore it.

import type { TabRef } from "./nav-context";
import type { PaletteCreateKind } from "./paletteModel";

function browserLocation(): Location | null {
  return typeof window !== "undefined" && window.location ? window.location : null;
}

/** True when the current URL requests the quick-capture surface (`?capture=1`). */
export function captureRequested(): boolean {
  const loc = browserLocation();
  if (!loc) return false;
  return new URLSearchParams(loc.search).get("capture") != null;
}

/** A shell-provided closer for the capture window. The desktop shell injects one that calls
 *  the Wails runtime `Window.Close()` — the browser `window.close()` does NOT close a Wails
 *  native (frameless) window. Web leaves it unset and falls back to `window.close()`. */
type CaptureCloser = () => void;
let injectedCloser: CaptureCloser | null = null;

/** Register a platform closer for the capture window (called once by the desktop shell). */
export function setCaptureWindowCloser(closer: CaptureCloser | null): void {
  injectedCloser = closer;
}

/** Dismiss the capture window: the injected closer if a shell set one (desktop), otherwise
 *  the browser `window.close()` (web tab). No-op where unavailable. */
export function closeCaptureWindow(): void {
  if (injectedCloser) {
    injectedCloser();
    return;
  }
  if (typeof window !== "undefined" && typeof window.close === "function") window.close();
}

/** The event the desktop shell's File › New Note / Task / Canvas sends the main window; its
 *  payload is `{ what }`. AppShell opens the palette on that command. */
export const CAPTURE_NEW_EVENT = "capture.new";

/** The in-app shortcuts for the same three, and ⌥⇧E for a new event: ⌥⇧ and a letter (the
 *  palette lists them, see PALETTE_COMMANDS' `shortcutKey`), beside ⌥⇧Space for the palette
 *  itself. Matched on `code`, since ⌥ changes the character a key types. The event one only
 *  answers while some calendar takes new events, so it has no File-menu twin on the desktop. */
export const CAPTURE_NEW_KEYS: Record<string, PaletteCreateKind> = { KeyN: "note", KeyT: "task", KeyC: "canvas", KeyE: "event" };

/** The event the desktop shell relays to the main window when the capture window asks for
 *  something to be opened; its payload is the TabRef, plus `newTab: true` when it should get a
 *  tab of its own (⇧⏎). AppShell listens for it. */
export const PALETTE_OPEN_EVENT = "palette.open";

/** A shell-provided way to show something in the *main* window from the capture window, which
 *  is a webview of its own with no navigator. The desktop shell injects one that posts the ref
 *  to the Go side, which surfaces the main window and relays PALETTE_OPEN_EVENT to it. */
type CaptureResultOpener = (ref: TabRef, opts?: { newTab?: boolean }) => void;
let injectedOpener: CaptureResultOpener | null = null;

/** Register the platform opener for capture-window results (called once by the desktop shell). */
export function setCaptureResultOpener(opener: CaptureResultOpener | null): void {
  injectedOpener = opener;
}

/** Open a palette result in the main window. No-op where no shell set an opener. */
export function openCaptureResult(ref: TabRef, opts?: { newTab?: boolean }): void {
  injectedOpener?.(ref, opts);
}
