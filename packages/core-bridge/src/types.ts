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
  /** Stage a file the user picked so core can read it by handle — web only (PLAN §6.12): the
   *  bytes stay in JS instead of crossing invoke as JSON. Native shells pass a path instead and
   *  leave this undefined. */
  stageFile?(name: string, bytes: Uint8Array): string;
  /** Drop a staged file. */
  releaseFile?(handle: string): void;
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
  /** When the task starts: the moment it becomes something to work on (ISO timestamp). */
  startAt?: string | null;
  /** Filed under Someday in place of a start (PLAN-scheduling.md §1): out of every task list
   *  but the Someday filter. Never set together with `startAt`. */
  someday: boolean;
  /** The task's deadline (ISO timestamp). Keeps its original "due" name on the wire. */
  dueAt?: string | null;
  /** The task's reminders, normalized by core: leads (longest first), then instants. */
  reminders: TaskReminder[];
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

/** One task reminder (mirrors core/domain.Reminder, PLAN §6.4): exactly one of `at` (an
 *  absolute ISO instant) or `before` (a lead counted back from the deadline, as a single-unit
 *  ISO-8601 duration: "PT0M" at the deadline, "PT1H", "P1D", "P3D", "P1W", "P2W", "P1M"). A
 *  lead on a task with no deadline never fires until one is set. */
export interface TaskReminder {
  at?: string;
  before?: string;
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
export type TrashEntityType = "note" | "task" | "document" | "habit" | "canvas";

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
  /** The area's page (PLAN-areas.md §1): an emoji, a cover image (a document id) and a
   *  markdown description. */
  icon?: string | null;
  coverDocumentId?: string | null;
  descriptionMd: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version: number;
  dirty: boolean;
}

/** How a calendar is sourced: a read-only ICS subscription/upload, or a two-way CalDAV
 *  collection belonging to a CalendarAccount (PLAN-caldav.md). */
export type CalendarFeedKind = "ics" | "caldav";

/** One calendar (PLAN §6.7): an ICS subscription, an uploaded file, or a CalDAV collection. Syncs
 *  bidirectionally. Under end-to-end encryption (PLAN §E2EE) the client — not the server — fetches
 *  it and expands the events, so the URL and event content stay opaque to the server. */
export interface CalendarFeed {
  id: string;
  name: string;
  /** Absent on rows written before CalDAV existed; treat as "ics". */
  kind?: CalendarFeedKind;
  /** The owning CalendarAccount of a CalDAV calendar. */
  accountId?: string | null;
  /** A CalDAV calendar the login may not write to (shared, holidays). */
  readOnly?: boolean;
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
export type CalendarItemKind = "event" | "task" | "note" | "project";

/** One entry in the merged, read-only calendar view produced by `calendar.range` — feed
 *  events, due tasks, and dated notes on one timeline (PLAN §6.7). */
export interface CalendarItem {
  id: string;
  kind: CalendarItemKind;
  title: string;
  startsAt: string;
  endsAt?: string | null;
  allDay: boolean;
  /** An open task or project with both a start and a deadline (PLAN-scheduling.md §4):
   *  `startsAt`/`endsAt` are those instants, and it belongs in the all-day band of every local
   *  day from one to the other. Not `allDay` (no UTC date markers) — place it with `itemDays`. */
  span?: boolean;
  /** Id of the backing row (event/task/note/project) so the UI can open it. */
  sourceId: string;
  /** Event location/description (shown on hover / in the mobile detail view); null otherwise. */
  location?: string | null;
  description?: string | null;
  /** Feed color for events; null for tasks and notes. */
  color?: string | null;
  /** The calendar an event belongs to; absent for tasks and notes. */
  feedId?: string;
  /** True for an event in a writable CalDAV calendar: it can be edited and deleted here. */
  editable?: boolean;
  /** True for an occurrence of a repeating event — deleting asks "this one or all?", and its
   *  time cannot be changed from Companion yet. */
  recurring?: boolean;
  /** True while a local change has not reached the calendar provider yet. */
  pending?: boolean;
}

/** A CalDAV login as the UI sees it (PLAN-caldav.md). The credential never leaves the core. */
export interface CalendarAccount {
  id: string;
  name: string;
  serverUrl: string;
  username: string;
  /** "basic" (a password) or "oauth-google" (a Google sign-in, which is reconnected rather than
   *  given a new password). */
  authKind: "basic" | "oauth-google";
  /** False on a device that holds no password for the account (an unencrypted Companion
   *  account keeps it only where it was typed), or — for a Google account — one whose build uses
   *  a different OAuth client id than the grant. Either way this device cannot sync it itself. */
  hasCredential: boolean;
  /** The most recent sync failure, or null when healthy. */
  lastError?: string | null;
  calendars: CalendarFeed[];
}

/** An edit the provider refused because the event changed there first; its copy was kept. */
export interface CalendarConflict {
  feedId: string;
  title: string;
}

/** A project — belongs to exactly one area (mirrors core/domain.Project). */
export interface Project {
  id: string;
  areaId: string;
  name: string;
  color?: string | null;
  /** The project's page — see Area. */
  icon?: string | null;
  coverDocumentId?: string | null;
  descriptionMd: string;
  sortOrder: number;
  archivedAt?: string | null;
  /** The project's schedule, shaped like a task's (PLAN-scheduling.md §2): ISO timestamps;
   *  `dueAt` is presented as "Deadline". With both, the project spans those days on the calendar. */
  startAt?: string | null;
  dueAt?: string | null;
  /** Filed under Someday in place of a start: off the sidebar, listed (labelled) only on its
   *  area's overview. Never set together with `startAt`. */
  someday: boolean;
  /** Set once the project is completed: hidden everywhere but the Logbook. */
  completedAt?: string | null;
  /** How the project repeats — at most one: an RRULE schedule, or an interval after it is
   *  completed ("P3D", "P2W", "P1M", "P1Y"). The server spawns the next copy and moves the
   *  definition onto it (PLAN-scheduling.md §3). */
  repeatRule?: string | null;
  repeatAfter?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version: number;
  dirty: boolean;
}

/** A membership edge: project ⇄ note/task/habit/canvas, or a calendar ("calendar" is a feed id,
 *  "calendar_account" an account id) — mirrors core/domain.ProjectMember. */
export interface ProjectMember {
  id: string;
  /** The CONTAINER's id: a project's, or an area's when `containerType` is "area". */
  projectId: string;
  /** Absent on rows written before areas held content — read that as "project". */
  containerType?: "project" | "area";
  entityType: "note" | "task" | "habit" | "canvas" | "calendar" | "calendar_account";
  entityId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version: number;
  dirty: boolean;
}

/** One project in the sidebar tree, with its live indicators (null until data exists). */
/** A project-scoped, drag-ordered task list. Lists are scaffolding like projects: never
 *  trashed, they delete immediately (their items go with them; the tasks stay). */
export interface List {
  id: string;
  projectId: string;
  name: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version: number;
  dirty: boolean;
}
export type ListItemKind = "task" | "heading";
/** One row of a list: a task reference or a heading ("sublist") that groups the task rows
 *  beneath it. Tasks and headings share a single flat sortOrder, so a task's sublist is the
 *  nearest heading above it. */
export interface ListItem {
  id: string;
  listId: string;
  kind: ListItemKind;
  taskId?: string | null;
  /** Heading text; empty for task items. */
  title: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version: number;
  dirty: boolean;
}
export interface SidebarProject {
  id: string;
  name: string;
  color?: string | null;
  icon?: string | null;
  taskProgress: number | null; // 0..1 done/(open+done) member tasks; null if none
  habitHealth: number | null; // 0..1 mean member-habit streak health; null if none
  /** A Someday project: left off the sidebar, labelled on its area's overview. (Completed
   *  projects never appear in the tree at all.) */
  someday: boolean;
}

/** One area heading and its projects. */
export interface SidebarArea {
  id: string;
  name: string;
  color?: string | null;
  icon?: string | null;
  projects: SidebarProject[];
}

/** The whole navigation tree (mirrors core/store.SidebarData). */
export interface SidebarData {
  areas: SidebarArea[];
  unsorted: SidebarProject[];
}

// ---- Canvases (PLAN-canvases.md) ----------------------------------------------------

/** A canvas board (mirrors core/domain.Canvas). Trashable like a note; nodes and edges
 *  are separate synced rows so devices editing different nodes merge cleanly. */
export interface Canvas {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  deletingAt?: string | null;
  deletedAt?: string | null;
  version: number;
  dirty: boolean;
}

/** Node kinds: text/group/link mirror the JSON Canvas spec; note/task/event/image embed
 *  app entities by reference. */
export type CanvasNodeKind = "text" | "group" | "note" | "task" | "event" | "image" | "link";
export type CanvasRefType = "note" | "task" | "event" | "document";
export type CanvasSide = "top" | "right" | "bottom" | "left";
/** Edge endings: nothing, an open chevron, a solid triangle, a hollow dot, or a solid dot. */
export type CanvasEnd = "none" | "arrow" | "arrowFilled" | "dot" | "dotFilled";
/** Edge line styles: a bezier curve, orthogonal steps, or a direct line. */
export type CanvasEdgeStyle = "curved" | "step" | "straight";

/** One item on a board (mirrors core/domain.CanvasNode). Coordinates are absolute canvas
 *  units, top-left origin. `data` carries the kind-specific content: `{text}` for stickies,
 *  `{label}` for groups, `{url,title,description,imageUrl,siteName,faviconUrl}` for links,
 *  `{title,startsAt}` cached for events. */
export interface CanvasNode {
  id: string;
  canvasId: string;
  kind: CanvasNodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  color?: string | null;
  refType?: CanvasRefType | null;
  refId?: string | null;
  data?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version: number;
  dirty: boolean;
}

/** A connector between two nodes of one board. A missing side means "auto". */
export interface CanvasEdge {
  id: string;
  canvasId: string;
  fromNodeId: string;
  toNodeId: string;
  fromSide?: CanvasSide | null;
  toSide?: CanvasSide | null;
  fromEnd: CanvasEnd;
  toEnd: CanvasEnd;
  style: CanvasEdgeStyle;
  label: string;
  color?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version: number;
  dirty: boolean;
}

/** This device's saved viewport for a board (local-only). */
export interface CanvasView {
  x: number;
  y: number;
  zoom: number;
}

/** Hydrated summaries of the entities a board embeds, resolved by the core in one call.
 *  `missing` marks a trashed/deleted target so the node can render a "gone" state. */
export interface CanvasRefs {
  notes: Record<string, { title: string; excerpt: string; objectTypeId?: string | null; missing?: boolean }>;
  tasks: Record<string, { title: string; status: TaskStatus; dueAt?: string | null; missing?: boolean }>;
  events: Record<string, { title: string; startsAt: string; endsAt?: string | null; allDay: boolean; location?: string | null; missing?: boolean }>;
  documents: Record<string, { filename: string; mime: string; missing?: boolean }>;
}

/** The wire shape of canvases.get. */
export interface CanvasDocument {
  canvas: Canvas;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  refs: CanvasRefs;
  view?: CanvasView | null;
}

/** Open Graph / Twitter-card metadata for a link node (mirrors core/unfurl.Preview). Empty
 *  strings mean "not present"; `url` is the final URL after redirects. */
export interface LinkPreview {
  url: string;
  title: string;
  description: string;
  imageUrl: string;
  siteName: string;
  faviconUrl: string;
  /** Why the page couldn't be fetched (the card then carries only the URL). On web this is
   *  the case until a sync server is configured to proxy the fetch. */
  error?: string;
}

/** One ink group drawn over a note (PLAN-drawing.md): strokes drawn close together, pinned
 *  to the text under them. `data` is the editor's payload (its strokes and text anchor); the
 *  core stores it as-is and encrypts it whole on the wire. */
export interface NoteInk {
  id: string;
  noteId: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  version: number;
  dirty: boolean;
}
