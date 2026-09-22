import type { CoreBridge } from "./types";

/** A slice of the workspace Settings › Danger Zone can clear (mirrors core/store.DataKind). The
 *  last three only go with everything else. */
export type DataKind =
  | "notes"
  | "tasks"
  | "canvases"
  | "chats"
  | "calendar"
  | "areas"
  | "files"
  | "objectTypes"
  | "agents"
  | "exports";

/** How many live rows (the Trash included) each kind holds right now. */
export interface DataSummary {
  notes: number;
  tasks: number;
  canvases: number;
  chats: number;
  calendars: number;
  calendarAccounts: number;
  areas: number;
  projects: number;
  files: number;
  objectTypes: number;
  agents: number;
  exports: number;
}

/** Typed wrapper over the data.* core methods behind Settings › Danger Zone. A clear is permanent
 *  and skips the Trash. Its deletions sync like any other, so on a signed-in device the data
 *  leaves every device and the server. */
export function dataApi(core: CoreBridge) {
  return {
    summary: () => core.invoke<DataSummary>("data.summary"),
    /** Permanently delete the given kinds. Resolves with how many rows of each went. */
    clear: (kinds: DataKind[]) => core.invoke<{ cleared: Partial<Record<DataKind, number>> }>("data.clear", { kinds }),
    /** Permanently delete everything: every kind, settings such as agents and exports included. */
    clearAll: () => core.invoke<{ cleared: Partial<Record<DataKind, number>> }>("data.clear", { all: true }),
  };
}

export type DataApi = ReturnType<typeof dataApi>;
