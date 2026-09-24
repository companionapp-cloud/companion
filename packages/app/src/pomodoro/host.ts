// Pomodoros: a timed focus session on a task, started from the task's stopwatch button. The
// timer lives in the macOS menu bar (apps/desktop/pomodoro.go) and opens a window of its own
// (`?pomodoro=1`, PomodoroView), so only the desktop shell can host one: it injects a host,
// and everywhere else the stopwatch button hides itself. Even there it is an opt-in tool,
// switched on per device in Settings › Tools (usePomodoroEnabled). The pomodoros themselves
// are core rows and sync like everything else.

export interface PomodoroHost {
  /** Bring up the timer window. */
  showTimer(): void;
  /** Whether the tool is switched on for this device. */
  isEnabled(): Promise<boolean>;
  /** Switch it on or off, resolving to the saved value. Switching off gives up a pomodoro
   *  that is running. */
  setEnabled(enabled: boolean): Promise<boolean>;
  /** Fit the menu bar panel to its layout and put native glass under its modules (macOS):
   *  `height` is what the layout needs; each rect is a module's box in the page, in points from
   *  the top-left, with its corner radius. Where a shell has none, the panel draws its modules
   *  itself. */
  setGlass?(layout: { height: number; rects: GlassRect[] }): void;
  /** Bring up the quick-capture panel (the menu bar panel's Quick Capture tile). */
  capture?(): void;
  /** Bring Companion's main window forward (the menu bar panel's Open Companion button). */
  openApp?(): void;
}

/** One module's box in the timer page, for the native glass under it. */
export interface GlassRect {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

/** The event the shell sends every window when the tool is switched on or off; its payload is
 *  `{ enabled }`. */
export const POMODORO_ENABLED_EVENT = "pomodoro.enabled";

let injectedHost: PomodoroHost | null = null;

/** Register the platform's pomodoro host (called once by the desktop shell). */
export function setPomodoroHost(host: PomodoroHost | null): void {
  injectedHost = host;
}

/** The shell's pomodoro host, or null where there is no timer to show (web, mobile). */
export function pomodoroHost(): PomodoroHost | null {
  return injectedHost;
}

/** True when the current URL requests the timer window (`?pomodoro=1`). */
export function pomodoroRequested(): boolean {
  if (typeof window === "undefined" || !window.location) return false;
  return new URLSearchParams(window.location.search).get("pomodoro") != null;
}

/** mm:ss for a number of milliseconds left, never negative. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
