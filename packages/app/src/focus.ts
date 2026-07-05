// Focus mode: a single note rendered without the app chrome (rail/toolbar), routed
// by a URL query param so it can live in its own tab or window. Web/desktop only —
// on native (no browser window) these degrade to no-ops.

export const FOCUS_PARAM = "note";

// React Native defines a `window` global without `location`/`open`, so feature-detect
// the actual APIs rather than just `typeof window`.
function browserLocation(): Location | null {
  return typeof window !== "undefined" && window.location ? window.location : null;
}

/** The note id to show in focus mode, if the current URL requests one. */
export function focusNoteId(): string | null {
  const loc = browserLocation();
  if (!loc) return null;
  return new URLSearchParams(loc.search).get(FOCUS_PARAM);
}

/** The focus-mode URL for a note (same document, `?note=<id>`). */
export function focusUrl(id: string): string {
  const base = browserLocation()?.pathname ?? "/";
  return `${base}?${FOCUS_PARAM}=${encodeURIComponent(id)}`;
}

/** Open a note in its own window/tab in focus mode (new tab on web, new window in the
 * desktop webview). No-op where `window.open` is unavailable (native). */
export function openNoteWindow(id: string): void {
  if (typeof window === "undefined" || typeof window.open !== "function") return;
  window.open(focusUrl(id), "_blank", "noopener,width=820,height=720");
}
