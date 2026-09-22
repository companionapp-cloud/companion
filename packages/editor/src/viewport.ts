/** Fired on `window` by a web host right after it resizes the app around the on-screen keyboard
 *  (apps/web/src/viewportFit.ts). The editor's scroller just lost its bottom, often where the
 *  caret was, so a focused editor answers by bringing the caret back into view. */
export const VIEWPORT_FIT_EVENT = "companion:viewportfit";

/** The part of the window the reader can see, in the client coordinates popups are placed in:
 *  the whole window, less whatever an on-screen keyboard covers. iOS keeps the layout viewport
 *  (and `innerHeight`) full height under its keyboard; only the visual viewport shrinks. */
export function visibleArea(): { left: number; top: number; right: number; bottom: number } {
  const vv = window.visualViewport;
  if (!vv) return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  return { left: vv.offsetLeft, top: vv.offsetTop, right: vv.offsetLeft + vv.width, bottom: vv.offsetTop + vv.height };
}
