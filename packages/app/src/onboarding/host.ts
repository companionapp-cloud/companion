import type { SettingsSectionId } from "../settingsSections";

// What the tutorials need from the shell they run in. Each shell (the desktop AppShell, the
// mobile web shell, the native app) builds one from its own navigation, so one engine and one set
// of tutorials serve all three.

/** Where the user is, in the terms tutorials start and run on. */
export type Place =
  | "home"
  | "today"
  | "chat"
  | "calendar"
  | "notes"
  | "note"
  | "tasks"
  | "task"
  | "graph"
  | "area"
  | "area-section"
  | "project"
  | "project-section"
  | "settings"
  | "other";

/** Which set of steps a tutorial shows: the desktop page, or the phone screens. */
export type Layout = "desktop" | "mobile";

/** The tools a tutorial can open from Settings. */
export type ToolPlace = "home" | "today" | "chat" | "calendar" | "notes" | "tasks" | "graph";

/** Moving around, as tutorials need to. */
export interface TourNav {
  go: (to: ToolPlace) => void;
  openNote: (id: string) => void;
  openTask: (id: string) => void;
  openArea: (id: string) => void;
  openProject: (id: string) => void;
  openSettings: (section?: SettingsSectionId) => void;
  back: () => void;
}

export interface TourHost extends TourNav {
  layout: Layout;
  place: Place;
  /** Changes whenever the user moves: to another page, or another document on it. */
  placeKey: string;
  /** The note or task on screen, if any. */
  doc: { kind: "note" | "task"; id: string } | null;
  /** Space system chrome takes at the window's edges (a phone's status bar and home bar). */
  insets?: { top: number; bottom: number };
}
