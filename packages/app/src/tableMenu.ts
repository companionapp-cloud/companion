import type { TableMenuPresenter } from "@companion/editor";

// Table cell menu presenter injection. The editor renders its own HTML popup by default (web);
// the desktop shell injects a Wails-backed native-menu presenter here (see
// apps/desktop/frontend/src/main.tsx), mirroring setFocusWindowOpener / setCaptureWindowCloser.
// The shared note editor passes whatever's registered through to <Editor tableMenuPresenter>.

let injected: TableMenuPresenter | undefined;

/** Register the platform's native table-menu presenter (called once by the desktop shell).
 * Pass undefined to clear it (web never sets one, so the editor uses its HTML popup). */
export function setTableMenuPresenter(presenter: TableMenuPresenter | undefined): void {
  injected = presenter;
}

/** The registered presenter, or undefined (→ the editor's built-in HTML popup). */
export function tableMenuPresenter(): TableMenuPresenter | undefined {
  return injected;
}
