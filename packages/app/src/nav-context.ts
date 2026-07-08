import { createContext, useContext } from "react";

export type ViewId = "chat" | "calendar" | "notes" | "tasks" | "habits" | "graph" | "trash" | "settings" | "notifications";

/** The content types a project drills into (its sub-nav). */
export type ProjectSection = "notes" | "tasks" | "calendars" | "habits";

/** A document open in a workspace tab. */
export type TabRef = { kind: "note" | "task"; id: string };

/** One workspace tab slot: a stable uid, its (possibly empty) document, and that tab's own
 *  selection history. Notes and tasks share one strip; an empty slot renders as "Nothing
 *  selected". `back`/`fwd` (oldest→newest) drive per-tab Back/Forward — each tab remembers
 *  the documents it has shown, independent of the browser/route history. */
export type Tab = { uid: string; ref: TabRef | null; back: TabRef[]; fwd: TabRef[] };

/** The current navigable location, derived from the React Navigation route. The workspace
 * sections (notes/tasks) only pick which list the left column browses — the content area
 * always shows the active tab (which may hold a note, a task, or nothing). A project is a
 * three-level drill-down, each a deep-linkable URL on web. */
export type NavLocation =
  | { kind: "view"; view: Exclude<ViewId, "notes" | "tasks"> }
  | { kind: "notes" }
  | { kind: "tasks" }
  | { kind: "project"; projectId: string; section?: ProjectSection; itemId?: string };

/** The app-facing navigation API. Implemented on top of React Navigation (routing +
 * URL linking) plus a thin layer for the workspace tab strip and forward history. */
export interface Navigator {
  current: NavLocation;
  activeView: ViewId | "project";
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
  /** The active tab (tabs[activeIndex]). */
  activeTab: Tab;
  /** Set the active tab's document to this note (overrides whatever it held). */
  openNote: (id: string) => void;
  /** Set the active tab's document to this task. */
  openTask: (id: string) => void;
  /** Open a document in a new tab and make it active (e.g. following a link chip). */
  openInNewTab: (ref: TabRef) => void;
  /** Add a new empty tab and make it active. */
  addTab: () => void;
  /** Make the tab at `index` active. */
  selectTab: (index: number) => void;
  /** Close the tab at `index`; the strip never drops below one (empty) tab. */
  closeTab: (index: number) => void;
  /** Pop the tab's document out to its own window/browser tab, then close the tab. */
  expandTab: (index: number) => void;

  // --- projects -------------------------------------------------------------
  /** Open a project's overview (its sub-nav). */
  openProject: (projectId: string) => void;
  /** Push into one of a project's content sections (its list). */
  openProjectSection: (projectId: string, section: ProjectSection) => void;
  /** Push into a single item within a project section. */
  openProjectItem: (projectId: string, section: ProjectSection, itemId: string) => void;
}

export const NavContext = createContext<Navigator | null>(null);

export function useNav(): Navigator {
  const v = useContext(NavContext);
  if (!v) throw new Error("useNav must be used within the app navigator");
  return v;
}
