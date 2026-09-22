// ⌘W on the desktop closes the active tab first, and the window only once nothing is left open.
// The Go side's File › Close Tab sends the main window TAB_CLOSE_EVENT; AppShell closes the
// active tab, or — down to the one empty tab the strip always keeps — calls closeMainWindow,
// which the desktop shell wires to the native window close (hide to the menu bar).

/** The event the desktop shell's File › Close Tab (⌘W) sends the main window. No payload. */
export const TAB_CLOSE_EVENT = "tab.close";

type WindowCloser = () => void;
let injectedCloser: WindowCloser | null = null;

/** Register a platform closer for the main window (called once by the desktop shell). */
export function setMainWindowCloser(closer: WindowCloser | null): void {
  injectedCloser = closer;
}

/** Close the main window, where a shell provided a way to. */
export function closeMainWindow(): void {
  injectedCloser?.();
}
