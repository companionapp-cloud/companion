// Quick capture: a compact, frameless window (desktop) that jots down a new note or task
// and closes itself. Reached via the `?capture=1` URL the desktop shell's global
// Cmd/Ctrl+Shift+N shortcut opens (apps/desktop/main.go). Web/native ignore it.

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
