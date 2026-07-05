// Focus mode: a single note or task rendered without the app chrome (rail/toolbar/tabs),
// routed by a URL query param so it can live in its own browser tab or desktop window.
// Web/desktop only — on native (no browser window) these degrade to no-ops.

export type FocusKind = "note" | "task";
export type FocusTarget = { kind: FocusKind; id: string };

// React Native defines a `window` global without `location`/`open`, so feature-detect
// the actual APIs rather than just `typeof window`.
function browserLocation(): Location | null {
  return typeof window !== "undefined" && window.location ? window.location : null;
}

/** The note/task to show in focus mode, if the current URL requests one (`?note=` or
 *  `?task=`). */
export function focusTarget(): FocusTarget | null {
  const loc = browserLocation();
  if (!loc) return null;
  const params = new URLSearchParams(loc.search);
  const note = params.get("note");
  if (note) return { kind: "note", id: note };
  const task = params.get("task");
  if (task) return { kind: "task", id: task };
  return null;
}

/** The focus-mode URL for a document (same document path, `?<kind>=<id>`). */
export function focusUrl(kind: FocusKind, id: string): string {
  const base = browserLocation()?.pathname ?? "/";
  return `${base}?${kind}=${encodeURIComponent(id)}`;
}

/** A shell-provided opener. The desktop shell injects one that asks the Wails Go process
 *  to spawn a real window (browser `window.open` doesn't create app windows in the Wails
 *  webview); web/native leave it unset and fall back below. */
type FocusOpener = (target: FocusTarget) => void;
let injectedOpener: FocusOpener | null = null;

/** Register a platform opener for focus windows (called once by the desktop shell). */
export function setFocusWindowOpener(opener: FocusOpener | null): void {
  injectedOpener = opener;
}

/** Open a document in its own window/tab in focus mode: the injected opener if a shell set
 *  one (desktop), otherwise a new browser tab via `window.open` (web). No-op on native. */
export function openFocusWindow(kind: FocusKind, id: string): void {
  if (injectedOpener) {
    injectedOpener({ kind, id });
    return;
  }
  if (typeof window === "undefined" || typeof window.open !== "function") return;
  window.open(focusUrl(kind, id), "_blank", "noopener,width=820,height=720");
}
