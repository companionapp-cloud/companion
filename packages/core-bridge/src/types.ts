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

/** Structured object metadata (mirrors a note/task props_json blob). Keys are field
 *  keys from the archetype's schema; values are field-type dependent. */
export type ObjectProps = Record<string, unknown>;

/** A note as returned by the core (mirrors core/domain.Note). */
export interface Note {
  id: string;
  title: string;
  contentMd: string;
  date?: string | null;
  /** Archetype id (PLAN §6.3): null/absent is a plain note; otherwise selects an
   *  ObjectType whose schema validates `props`. */
  objectTypeId?: string | null;
  props?: ObjectProps;
  createdAt: string;
  updatedAt: string;
  /** Trash marker (PLAN §4.3): when set, the note is in the Trash, due to be permanently
   *  deleted at this instant, and hidden from every list but the Trash. */
  deletingAt?: string | null;
  deletedAt?: string | null;
  version: number;
  dirty: boolean;
}

/** A document — a file embedded in a note (mirrors core/domain.Document, PLAN §6.9). The
 *  row is metadata only: the bytes live in the platform BlobStore, content-addressed by
 *  `sha256`, and sync out-of-band. A document is also a graph node that notes embed with
 *  `![[doc:<id>]]`. `blobUploaded` is a client-only flag and never crosses the wire. */
export interface Document {
  id: string;
  filename: string;
  mime: string;
  size: number;
  /** Lowercase 64-char hex content address of the bytes; immutable for given bytes. */
  sha256: string;
  createdAt: string;
  updatedAt: string;
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
  objectTypeId?: string | null;
  props?: ObjectProps;
  createdAt: string;
  updatedAt: string;
  deletingAt?: string | null;
  deletedAt?: string | null;
  version: number;
  dirty: boolean;
}

/** A repeating-task definition (seed) paired with its next computed occurrence (mirrors
 *  bridge.RepeatingTask, PLAN §6.4). `nextOccurrence` is null when the rule is exhausted. It
 *  is the only thing a client with no server configured can show, since occurrences never
 *  materialize locally. */
export interface RepeatingTask extends Task {
  nextOccurrence?: string | null;
}

/** Result of tasks.repeatPreview: whether an RRULE parses, and if so its upcoming
 *  occurrences as ISO timestamps (mirrors the bridge's repeat-preview payload). */
export interface RepeatPreview {
  valid: boolean;
  occurrences?: string[];
}

/** Which entity kinds an object type can archetype (mirrors core/domain AppliesTo*). */
export type AppliesTo = "note" | "task" | "both";

/** A field's declared type in an object schema (mirrors core/domain Field* constants). */
export type ObjectFieldType =
  | "text"
  | "number"
  | "date"
  | "select"
  | "multi_select"
  | "reference"
  | "checkbox"
  | "url";

/** One flat field definition in an object schema (mirrors core/domain.ObjectField). */
export interface ObjectField {
  key: string;
  type: ObjectFieldType;
  label?: string;
  required?: boolean;
  /** Choices for select / multi_select. */
  options?: string[];
  /** Target node type for a reference field ("note" | "task" | "habit"). */
  to?: string;
}

/** The parsed schema envelope (mirrors core/domain.ObjectSchema). `fields` drives
 *  validation + the form; `icon`/`color` are display config used to render archetyped
 *  notes/tasks (e.g. in the graph). rules/steps/layout are reserved for later (PLAN §6.3). */
export interface ObjectSchema {
  fields: ObjectField[];
  /** A design-system IconName; how this archetype's nodes are marked. */
  icon?: string;
  /** A hex color; how this archetype's nodes are tinted. */
  color?: string;
  rules?: unknown;
  steps?: unknown;
  layout?: unknown;
}

/** An object type / archetype definition (mirrors core/domain.ObjectType). `schemaJson`
 *  crosses the wire as a JSON object (Go json.RawMessage), so it's already the parsed
 *  schema envelope. */
export interface ObjectType {
  id: string;
  name: string;
  appliesTo: AppliesTo;
  schemaVersion: number;
  schemaJson: ObjectSchema;
  createdAt: string;
  updatedAt: string;
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

/** One entry in the in-app notification feed (mirrors bridge notificationFeedItem): a
 *  fire that already happened, its task's settled state, and whether the user read it. */
export interface NotificationFeedItem extends TaskNotification {
  /** The task is done/cancelled — show the entry muted. */
  settled: boolean;
  /** The user read this notification (synced across devices). */
  read: boolean;
}

/** The kinds of entity that can be trashed (mirrors the server's trashable tables). */
export type TrashEntityType = "note" | "task" | "document" | "habit";

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

/** A user-authored ICS subscription (PLAN §6.7). Syncs bidirectionally. Under end-to-end
 *  encryption (PLAN §E2EE) the client — not the server — fetches its URL and expands the events, so
 *  the URL and event content stay opaque to the server. */
export interface CalendarFeed {
  id: string;
  name: string;
  /** Subscription URL the client fetches (directly, or via the server's blind proxy on web);
   *  empty for an uploaded feed. */
  url: string;
  /** Raw contents of an uploaded .ics file, parsed on-device; null for URL feeds. */
  icsText?: string | null;
  color?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version: number;
  dirty: boolean;
}

/** An event occurrence expanded from a feed's ICS (PLAN §6.7). Under E2EE the client expands its
 *  feeds and pushes events like any entity, so they are dirty-tracked; content is encrypted before
 *  it leaves the device. */
export interface CalendarEvent {
  id: string;
  feedId: string;
  icsUid: string;
  title: string;
  startsAt: string;
  endsAt?: string | null;
  allDay: boolean;
  location?: string | null;
  description?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version: number;
  dirty: boolean;
}

/** Origin of a merged calendar entry. Habit occurrences will join this when habits land. */
export type CalendarItemKind = "event" | "task" | "note";

/** One entry in the merged, read-only calendar view produced by `calendar.range` — feed
 *  events, due tasks, and dated notes on one timeline (PLAN §6.7). */
export interface CalendarItem {
  id: string;
  kind: CalendarItemKind;
  title: string;
  startsAt: string;
  endsAt?: string | null;
  allDay: boolean;
  /** Id of the backing row (event/task/note) so the UI can open it. */
  sourceId: string;
  /** Event location/description (shown on hover / in the mobile detail view); null otherwise. */
  location?: string | null;
  description?: string | null;
  /** Feed color for events; null for tasks and notes. */
  color?: string | null;
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
