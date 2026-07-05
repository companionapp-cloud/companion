import { createContext, useContext } from "react";

export type ViewId = "chat" | "calendar" | "notes" | "tasks" | "graph";

/** The current navigable location, derived from the React Navigation route. */
export type NavLocation =
  | { kind: "view"; view: Exclude<ViewId, "notes"> }
  | { kind: "notes" }
  | { kind: "note"; id: string };

/** The app-facing navigation API. Implemented on top of React Navigation (routing +
 * URL linking) plus a thin layer for open-note tabs and forward history. */
export interface Navigator {
  current: NavLocation;
  tabs: string[];
  activeView: ViewId;
  canBack: boolean;
  canForward: boolean;
  back: () => void;
  forward: () => void;
  goView: (view: ViewId) => void;
  openNote: (id: string, opts?: { newTab?: boolean }) => void;
  closeTab: (id: string) => void;
  /** Deselect the active note (keeps tabs open, shows the notes list). No-op elsewhere. */
  deselect: () => void;
}

export const NavContext = createContext<Navigator | null>(null);

export function useNav(): Navigator {
  const v = useContext(NavContext);
  if (!v) throw new Error("useNav must be used within the app navigator");
  return v;
}
