// Keeps the app inside the part of the screen you can actually see.
//
// iOS doesn't resize a web page for its on-screen keyboard. Safari and Home Screen web apps keep
// the layout viewport, `100dvh` and `innerHeight` at full height (Safari 26 and 27.0 ignore
// `interactive-widget`), slide the keyboard over the bottom of the page, and pan the visual
// viewport to keep the caret in view. On an iPhone the keyboard also brings WebKit's form
// accessory bar (the ⌃⌄ capsule and ✓), a strip of glass over the page that nothing on the page
// can hide. So whatever a screen pins to its bottom edge (the editor's formatting bar, the chat
// composer) sits behind the keyboard and that strip, and the pan shoves the nav bar off the top.
//
// The visual viewport ends where that system chrome begins (the top of the accessory bar, where
// there is one). So while it is clearly shorter than the layout viewport, and not because someone
// pinch-zoomed, this pins #root over exactly the visible area (`html.vv-fit` plus the custom
// properties index.html's stylesheet reads). Every screen is a flex column, so its last row then
// sits right on top of the system's, and its first stays on screen. Android resizes the layout
// viewport itself (resizes-content), desktops have no on-screen keyboard, and WebKit resizes it
// too once Safari ships `interactive-widget` (on in WebKit trunk since 2026-08): the two
// viewports then agree and this stands down on its own.
//
// Published on <html> for anything positioned against the layout viewport (bottom sheets in a
// portal, say), not just #root:
//   --vv-top     how far the visible area starts below the layout viewport's top (the pan)
//   --vv-height  the visible area's height
//   --vv-bottom  how much of the layout viewport lies below the visible area (keyboard, less pan)
//   --vv-covered how much of the layout viewport the keyboard covers in total

import { VIEWPORT_FIT_EVENT } from "@companion/editor";

/** Less than this hidden (px) is rounding or a toolbar settling, not a keyboard. The shortest real
 *  case, an iPad's shortcut bar over a hardware keyboard, is well above it. */
const MIN_COVERED = 40;

const PROPS = ["--vv-top", "--vv-height", "--vv-bottom", "--vv-covered"] as const;

export function installViewportFit(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const html = document.documentElement;
  let fitted = false;
  let height = 0;
  let applied = "";

  const update = () => {
    const layoutHeight = window.innerHeight;
    const covered = layoutHeight - vv.height;
    // Pinch zoom shrinks the visual viewport too; that is the user looking closer, so leave the
    // page as laid out. (The viewport meta disables zoom, but iOS lets people zoom regardless.)
    const fit = vv.scale < 1.01 && covered >= MIN_COVERED;

    if (!fit) {
      if (fitted) {
        fitted = false;
        height = 0;
        applied = "";
        html.classList.remove("vv-fit");
        for (const name of PROPS) html.style.removeProperty(name);
      }
      // The app never scrolls the document, but iOS can leave it scrolled or panned once the
      // keyboard has gone (the gap-at-the-bottom bug, WebKit 297779 and 301857), which lifts the
      // whole shell off the bottom of the screen. Only once nothing is being typed in, though:
      // Safari can pan to a field before it reports the keyboard's height.
      if (!typing() && vv.scale < 1.01 && (window.scrollY !== 0 || vv.offsetTop !== 0)) window.scrollTo(0, 0);
      return;
    }

    if (!fitted) {
      fitted = true;
      // iOS panned the page to reveal the caret while the keyboard came up. The shell is about to
      // fit above the keyboard, where the editor keeps its own caret in view, so undo the pan: a
      // resting visual viewport keeps fixed-position popups and the caret in one coordinate
      // space. If iOS won't, --vv-top follows the pan instead.
      if (window.scrollY !== 0 || vv.offsetTop !== 0) window.scrollTo(0, 0);
    }
    const top = Math.max(0, vv.offsetTop);
    const bottom = Math.max(0, layoutHeight - top - vv.height);
    const next = `${top}|${vv.height}|${bottom}|${covered}`;
    if (next === applied) return;
    applied = next;
    html.style.setProperty("--vv-top", `${top}px`);
    html.style.setProperty("--vv-height", `${vv.height}px`);
    html.style.setProperty("--vv-bottom", `${bottom}px`);
    html.style.setProperty("--vv-covered", `${covered}px`);
    html.classList.add("vv-fit");
    // A pan only moves the app; a new height takes the bottom off whatever is being typed in.
    if (vv.height !== height) {
      height = vv.height;
      revealFocus();
    }
  };

  // `resize` covers the keyboard showing, hiding and changing height (its suggestion bar, a
  // different keyboard); `scroll` covers the visual viewport panning while it is up. iOS can
  // report a stale offsetTop in the event itself (WebKit 237851), so look again two frames on.
  let settle = 0;
  const onChange = () => {
    update();
    cancelAnimationFrame(settle);
    settle = requestAnimationFrame(() => {
      settle = requestAnimationFrame(update);
    });
  };
  vv.addEventListener("resize", onChange);
  vv.addEventListener("scroll", onChange);
  window.addEventListener("resize", onChange);
  update();
}

/** A field or editor has focus, so the keyboard is up or on its way. */
function typing(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLElement && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA");
}

/** The app just got shorter from the bottom, so whatever is being typed into may have dropped out
 *  of its scroller's view. Fields scroll themselves back; editors are told (they know where their
 *  caret is, see @companion/editor). */
function revealFocus(): void {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.scrollIntoView({ block: "nearest" });
  window.dispatchEvent(new Event(VIEWPORT_FIT_EVENT));
}
