// The desktop's File › Export menu (apps/desktop/export.go) lives outside the page, so the two
// talk through a host the desktop shell injects: the page says which formats apply to what it's
// showing, and the menu says which one was picked. Web and mobile inject nothing — their export
// controls are the ones in the page.
import type { ExportFormat } from "./types";

export interface ExportMenuHost {
  /** The formats the menu should offer for what this window shows; none disables the menu. */
  setFormats: (formats: ExportFormat[]) => void;
  /** Subscribe to the menu's picks. Returns the unsubscribe. */
  onRequest: (handler: (format: ExportFormat) => void) => () => void;
}

let host: ExportMenuHost | null = null;

export function setExportMenuHost(h: ExportMenuHost): void {
  host = h;
}

export function exportMenuHost(): ExportMenuHost | null {
  return host;
}
