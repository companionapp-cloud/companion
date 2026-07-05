import { createContext, useContext } from "react";

export type ViewId = "chat" | "calendar" | "notes" | "tasks" | "habits" | "graph" | "trash";

/** The content types a project drills into (its sub-nav). */
export type ProjectSection = "notes" | "tasks" | "calendars" | "habits";

/** The current navigable location, derived from the React Navigation route. A project
 * is a three-level drill-down: overview (no section) → a section's content list →
 * a single item, each a deep-linkable URL on web. */
export type NavLocation =
  | { kind: "view"; view: Exclude<ViewId, "notes"> }
  | { kind: "notes" }
  | { kind: "note"; id: string }
  | { kind: "project"; projectId: string; section?: ProjectSection; itemId?: string };

/** The app-facing navigation API. Implemented on top of React Navigation (routing +
 * URL linking) plus a thin layer for open-note tabs and forward history. */
export interface Navigator {
  current: NavLocation;
  tabs: string[];
  activeView: ViewId | "project";
  canBack: boolean;
  canForward: boolean;
  back: () => void;
  forward: () => void;
  goView: (view: ViewId) => void;
  openNote: (id: string, opts?: { newTab?: boolean }) => void;
  closeTab: (id: string) => void;
  /** Deselect the active note (keeps tabs open, shows the notes list). No-op elsewhere. */
  deselect: () => void;
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
