import { createContext, useContext } from "react";

export type ViewId = "today" | "chat" | "calendar" | "notes" | "tasks" | "canvases" | "habits" | "graph" | "trash" | "settings" | "notifications";

/** The content types a project drills into (its sub-nav). No section is the project's
 *  overview page (PLAN-areas.md §3). */
export type ProjectSection = "notes" | "tasks" | "lists" | "canvases" | "calendars" | "habits";
/** What an area holds directly — notes, tasks and canvases, never lists or calendars. */
export type AreaSection = "notes" | "tasks" | "canvases";

/** A place content is filed: a project, or an area. The two share one page layout — an
 *  overview, then a toolbar of sections — so views address either through this. */
export type ContainerRef = { kind: "project" | "area"; id: string };

/** The workspace sections: each browses one document kind. */
export type WorkspaceSection = "notes" | "tasks" | "canvases";
/** Views that are surfaces of their own (everything on the rail that isn't a browse list). */
export type SurfaceViewId = Exclude<ViewId, WorkspaceSection>;

/** A document a tab can show. */
export type DocRef = { kind: "note" | "task" | "canvas"; id: string };

/** What a tab holds. Tabs are the universal container: a tab carries a document (note,
 *  task, canvas), a browse list with nothing selected yet, a view (Today, Chat, Calendar,
 *  Graph, Settings, Trash…), or a project drill-down — so a graph or a chat can sit open
 *  beside a note instead of replacing it. */
export type TabRef =
  | DocRef
  | { kind: "browse"; section: WorkspaceSection }
  /** A view. `date` (YYYY-MM-DD) asks the Today view to open on that day — how a dated
   *  note is followed from the calendar into the daily-notes tool. `section` is the Settings
   *  section on show, carried in the URL (/settings/:section) so it survives a shell swap. */
  | { kind: "view"; view: SurfaceViewId; date?: string; section?: string }
  | { kind: "project"; projectId: string; section?: ProjectSection; itemId?: string; subItemId?: string }
  | { kind: "area"; areaId: string; section?: AreaSection; itemId?: string };

/** One tab slot: a stable uid, what it holds (null = a fresh, empty tab), and that tab's
 *  own history. `back`/`fwd` (oldest→newest) drive per-tab Back/Forward — each tab
 *  remembers the surfaces it has shown, like a browser tab. */
export type Tab = { uid: string; ref: TabRef | null; back: TabRef[]; fwd: TabRef[] };

export const SECTION_OF: Record<DocRef["kind"], WorkspaceSection> = { note: "notes", task: "tasks", canvas: "canvases" };

/** The document a tab is showing, if any — a plain document tab, or the item selected in a
 *  project's notes/tasks/canvases section (or the task selected inside a project list). */
export function docOfRef(ref: TabRef | null): DocRef | null {
  if (!ref) return null;
  if (ref.kind === "note" || ref.kind === "task" || ref.kind === "canvas") return ref;
  if ((ref.kind !== "project" && ref.kind !== "area") || !ref.itemId) return null;
  if (ref.section === "notes") return { kind: "note", id: ref.itemId };
  if (ref.section === "tasks") return { kind: "task", id: ref.itemId };
  if (ref.section === "canvases") return { kind: "canvas", id: ref.itemId };
  if (ref.kind === "project" && ref.section === "lists" && ref.subItemId) return { kind: "task", id: ref.subItemId };
  return null;
}

/** A stable identity for a tab's contents (equality, React keys, effect deps). */
export function keyOfRef(ref: TabRef | null): string {
  if (!ref) return "empty";
  switch (ref.kind) {
    case "browse":
      return `browse:${ref.section}`;
    case "view":
      return ref.date || ref.section ? `view:${ref.view}:${ref.date ?? ref.section}` : `view:${ref.view}`;
    case "project":
      return `project:${ref.projectId}:${ref.section ?? ""}:${ref.itemId ?? ""}:${ref.subItemId ?? ""}`;
    case "area":
      return `area:${ref.areaId}:${ref.section ?? ""}:${ref.itemId ?? ""}`;
    default:
      return `${ref.kind}:${ref.id}`;
  }
}

/** The location a tab's contents put on screen. */
export function locationOfRef(ref: TabRef | null): NavLocation {
  if (!ref) return { kind: "empty" };
  switch (ref.kind) {
    case "browse":
      return ref.section === "canvases" ? { kind: "canvases" } : { kind: ref.section };
    case "view":
      return { kind: "view", view: ref.view, date: ref.date, section: ref.section };
    case "project":
      return { kind: "project", projectId: ref.projectId, section: ref.section, itemId: ref.itemId, subItemId: ref.subItemId };
    case "area":
      return { kind: "area", areaId: ref.areaId, section: ref.section, itemId: ref.itemId };
    case "canvas":
      return { kind: "canvases", canvasId: ref.id };
    default:
      return { kind: SECTION_OF[ref.kind] as "notes" | "tasks" };
  }
}

/** The rail entry a tab lights up. */
export function viewOfRef(ref: TabRef | null): ViewId | "project" | "area" | null {
  if (!ref) return null;
  if (ref.kind === "browse") return ref.section;
  if (ref.kind === "view") return ref.view;
  if (ref.kind === "project" || ref.kind === "area") return ref.kind;
  return SECTION_OF[ref.kind];
}

/** The current navigable location, derived from the tab it is read in (see `visible`). The
 * workspace sections (notes/tasks/canvases) pick which list the left column browses; the
 * detail pane shows that tab's document, or "Nothing selected". A project is a
 * three-level drill-down, each a deep-linkable URL on web. The lists section goes one level
 * deeper: `itemId` is the list, `subItemId` the task selected inside it. */
export type NavLocation =
  /** A fresh tab holding nothing yet. */
  | { kind: "empty" }
  /** A view; `date` is the day the Today view was asked to open on, `section` the Settings
   *  section on show (see TabRef). */
  | { kind: "view"; view: SurfaceViewId; date?: string; section?: string }
  | { kind: "notes" }
  | { kind: "tasks" }
  /** The canvases browse list, with the open board (if any) in the URL: /canvases/:id. */
  | { kind: "canvases"; canvasId?: string }
  | { kind: "project"; projectId: string; section?: ProjectSection; itemId?: string; subItemId?: string }
  /** An area's page: its overview, or one of its sections (/area/<id>[/<section>[/<itemId>]]). */
  | { kind: "area"; areaId: string; section?: AreaSection; itemId?: string };

/** The container a location sits in, with its drill-down flattened — what the shared
 *  project/area page reads instead of branching on the kind. */
export function containerOfLocation(
  loc: NavLocation,
): (ContainerRef & { section?: ProjectSection; itemId?: string; subItemId?: string }) | null {
  if (loc.kind === "project") return { kind: "project", id: loc.projectId, section: loc.section, itemId: loc.itemId, subItemId: loc.subItemId };
  if (loc.kind === "area") return { kind: "area", id: loc.areaId, section: loc.section, itemId: loc.itemId };
  return null;
}

/** The app-facing navigation API. Implemented on top of React Navigation (routing +
 * URL linking) plus a thin layer for the workspace tab strip and forward history. */
export interface Navigator {
  /** Inside a tab's surface this is *that tab's* location; elsewhere, the active tab's. */
  current: NavLocation;
  /** The rail entry the active tab lights up (null for an empty tab). */
  activeView: ViewId | "project" | "area" | null;
  /** False inside a background tab's surface — every tab stays mounted so its state
   *  survives a switch, but only the visible one should claim shared, window-wide scopes
   *  (multiselect registration, keyboard shortcuts). */
  visible: boolean;
  canBack: boolean;
  canForward: boolean;
  back: () => void;
  forward: () => void;
  goView: (view: ViewId) => void;

  // --- workspace tabs (web/desktop) -----------------------------------------
  /** The open tab slots; always at least one. */
  tabs: Tab[];
  /** Index of the active tab. */
  activeIndex: number;
  /** Inside a tab's surface, that tab; elsewhere the active tab (tabs[activeIndex]). */
  activeTab: Tab;
  /** Set the active tab's document to this note (overrides whatever it held). */
  openNote: (id: string) => void;
  /** Set the active tab's document to this task. */
  openTask: (id: string) => void;
  /** Point the active tab at any surface a tab can hold: a document, a view (Today on a
   *  given day), or a project drill-down. For callers that first work out where an item
   *  lives, like the graph (see useOpenGraphNode). */
  openRef: (ref: TabRef) => void;
  /** Like `openRef`, but the surface being left behind is not remembered: it is not pushed
   *  onto the tab's Back stack, and any earlier visit to it is dropped from that history.
   *  For a surface that has ceased to exist — deleting the open document returns the tab to
   *  its browse list, and Back never lands on the tombstone. */
  replaceRef: (ref: TabRef) => void;
  /** Open a document in a new tab and make it active (e.g. following a link chip). */
  openInNewTab: (ref: TabRef) => void;
  /** Open a canvas board in the canvases view (PLAN-canvases.md). */
  openCanvas: (id: string) => void;
  /** Add a new empty tab and make it active. */
  addTab: () => void;
  /** Make the tab at `index` active. */
  selectTab: (index: number) => void;
  /** Close the tab at `index`; the strip never drops below one (empty) tab. */
  closeTab: (index: number) => void;
  /** Pop the tab's document out to its own window/browser tab, then close the tab. Only
   *  note and task tabs have a focus window. */
  expandTab: (index: number) => void;

  // --- projects -------------------------------------------------------------
  /** Open a project's overview (its sub-nav). */
  openProject: (projectId: string) => void;
  /** Push into one of a project's content sections (its list). */
  openProjectSection: (projectId: string, section: ProjectSection) => void;
  /** Push into a single item within a project section. */
  openProjectItem: (projectId: string, section: ProjectSection, itemId: string) => void;
  /** Push into an item nested under a section item — a task inside a list. */
  openProjectSubItem: (projectId: string, section: ProjectSection, itemId: string, subItemId: string) => void;

  // --- areas (PLAN-areas.md §3) ----------------------------------------------
  /** Open an area's overview. */
  openArea: (areaId: string) => void;
  /** Open a project's or an area's overview, a section of it, or an item in a section. An area
   *  has only the notes/tasks/canvases sections; any other falls back to its overview. */
  openContainer: (container: ContainerRef, section?: ProjectSection, itemId?: string) => void;
}

export const NavContext = createContext<Navigator | null>(null);

export function useNav(): Navigator {
  const v = useContext(NavContext);
  if (!v) throw new Error("useNav must be used within the app navigator");
  return v;
}
