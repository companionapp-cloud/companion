// Scheduled exports, Git sync and the file importer need two things from the shell that hosts them. The
// desktop injects both; the browser and the phones inject neither, and the core there reports
// that it can't run exports at all (export.capabilities).
//
//  - A folder chooser — where a filesystem export writes, or what the importer reads. The core
//    touches the path itself, so only a shell whose core runs on the same machine can offer one.
//  - A way in from outside the page: the desktop's File › Export › Schedule … Exports items ask
//    the app to open Settings › Export on a new export of that kind.
/** What the folder is for; the native chooser words itself to match. */
export type FolderPurpose = "export" | "import";

let folderPicker: ((purpose: FolderPurpose) => Promise<string | null>) | null = null;

/** Register the native folder chooser (the desktop calls this at startup). Resolves to the
 *  folder's absolute path, or null when cancelled. */
export function setExportFolderPicker(fn: (purpose: FolderPurpose) => Promise<string | null>): void {
  folderPicker = fn;
}

export const canPickExportFolder = (): boolean => folderPicker !== null;

export function pickExportFolder(purpose: FolderPurpose = "export"): Promise<string | null> {
  return folderPicker ? folderPicker(purpose) : Promise.resolve(null);
}

/** What the desktop's File menu can ask the app to open: a new scheduled filesystem export
 *  (Settings › Export), Git sync setup (Settings › Sync), or the file importer (Settings › Import). */
export type ExportRequestKind = "folder" | "git" | "import";

/** Sent by the desktop menu as {"kind": …} on the core's event stream. */
export const EXPORT_SCHEDULE_EVENT = "export.schedule";

/** The settings section each request opens. */
export const REQUEST_SECTION: Record<ExportRequestKind, "export" | "sync" | "import"> = { folder: "export", git: "sync", import: "import" };

// A request waiting for its settings section to mount and take it (the menu item navigates
// there first).
let pending: ExportRequestKind | null = null;
const listeners = new Set<() => void>();

export function requestScheduledExport(kind: ExportRequestKind): void {
  pending = kind;
  listeners.forEach((fn) => fn());
}

/** Takes the pending request if it is of this kind: whoever shows the dialog calls this once. */
export function takeScheduledExportRequest(kind: ExportRequestKind): boolean {
  if (pending !== kind) return false;
  pending = null;
  return true;
}

export function onScheduledExportRequest(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
