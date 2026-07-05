// The one CoreBridge API shape every platform implements (PLAN §3.1). UI code never
// calls invoke with raw strings — it goes through the typed helpers in ./notes.

/** CoreBridge is the universal handle to the Go core. */
export interface CoreBridge {
  /** Dispatch a core method; payload and result are JSON-serializable. */
  invoke<T>(method: string, payload?: unknown): Promise<T>;
  /** Subscribe to a core event (e.g. "notes.changed"); returns an unsubscribe fn. */
  on(event: string, cb: (payload: unknown) => void): () => void;
  /** Release the underlying core/store. */
  close(): void;
}

/** A value that can cross the SQLite bind/column boundary. */
export type SqlValue = string | number | Uint8Array | null;

/**
 * SqliteDriver is the JS-side SQLite implementation the wasm core drives through the
 * store.Driver seam (PLAN §3.2). Every method is async (awaited from Go).
 */
export interface SqliteDriver {
  exec(sql: string, params: SqlValue[]): Promise<{ rowsAffected: number }>;
  query(sql: string, params: SqlValue[]): Promise<{ rows: SqlValue[][] }>;
  close(): Promise<void>;
}

/** A note as returned by the core (mirrors core/domain.Note). */
export interface Note {
  id: string;
  title: string;
  contentMd: string;
  date?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Trash marker (PLAN §4.3): when set, the note is in the Trash, due to be permanently
   *  deleted at this instant, and hidden from every list but the Trash. */
  deletingAt?: string | null;
  deletedAt?: string | null;
  version: number;
  dirty: boolean;
}

/** A task's lifecycle status (mirrors core/domain task status constants). */
export type TaskStatus = "open" | "done" | "cancelled";

/** A task as returned by the core (mirrors core/domain.Task). A task is also a graph node
 *  — its `notesMd` is scanned for wikilinks like a note's body. */
export interface Task {
  id: string;
  title: string;
  notesMd: string;
  status: TaskStatus;
  dueAt?: string | null;
  remindAt?: string | null;
  completedAt?: string | null;
  repeatRule?: string | null;
  repeatSeedId?: string | null;
  createdAt: string;
  updatedAt: string;
  deletingAt?: string | null;
  deletedAt?: string | null;
  version: number;
  dirty: boolean;
}

/** A planned notification (mirrors core/notify.Notification). */
export interface TaskNotification {
  taskId: string;
  kind: "reminder" | "due";
  fireAt: string;
  title: string;
  body: string;
}

/** The kinds of entity that can be trashed (mirrors the server's trashable tables). */
export type TrashEntityType = "note" | "task" | "habit";

/** One row in the Trash, across entity types (mirrors bridge trashItem). */
export interface TrashItem {
  entityType: TrashEntityType;
  id: string;
  title: string;
  /** When this item is due to be permanently deleted. */
  deletingAt?: string | null;
  updatedAt: string;
}

/** An area — a flat sidebar heading grouping projects (mirrors core/domain.Area). */
export interface Area {
  id: string;
  name: string;
  color?: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version: number;
  dirty: boolean;
}

/** A project — belongs to exactly one area (mirrors core/domain.Project). */
export interface Project {
  id: string;
  areaId: string;
  name: string;
  color?: string | null;
  sortOrder: number;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version: number;
  dirty: boolean;
}

/** A membership edge: project ⇄ note/task/habit (mirrors core/domain.ProjectMember). */
export interface ProjectMember {
  id: string;
  projectId: string;
  entityType: "note" | "task" | "habit";
  entityId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version: number;
  dirty: boolean;
}

/** One project in the sidebar tree, with its live indicators (null until data exists). */
export interface SidebarProject {
  id: string;
  name: string;
  color?: string | null;
  taskProgress: number | null; // 0..1 done/(open+done) member tasks; null if none
  habitHealth: number | null; // 0..1 mean member-habit streak health; null if none
}

/** One area heading and its projects. */
export interface SidebarArea {
  id: string;
  name: string;
  color?: string | null;
  projects: SidebarProject[];
}

/** The whole navigation tree (mirrors core/store.SidebarData). */
export interface SidebarData {
  areas: SidebarArea[];
  unsorted: SidebarProject[];
}
