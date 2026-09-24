import type { CoreBridge } from "./types";

/** How a pomodoro settled. Only `completed` (at least one task finished inside the window) counts. */
export type PomodoroOutcome = "" | "completed" | "expired" | "cancelled";

/** A 25-minute focus block (mirrors core/domain.Pomodoro), with its end and task title. It works
 *  on one task at a time: finishing it counts toward the pomodoro, leaves `taskId` empty and stops
 *  the clock until the next is picked. The clock can be paused too. */
export interface Pomodoro {
  id: string;
  /** The task being worked on; empty while waiting for the next one. */
  taskId: string;
  taskTitle: string;
  /** Tasks finished inside the window. */
  tasksDone: number;
  startedAt: string;
  /** When the clock runs out, as of the state's `now` (it moves out while paused). */
  endsAt: string;
  /** Time left as of the state's `now`; holds still while paused. */
  remainingSec: number;
  /** Set while the clock is stopped. */
  pausedAt?: string | null;
  durationSec: number;
  /** Empty while it runs. */
  outcome: PomodoroOutcome;
  endedAt?: string | null;
  breakEndsAt?: string | null;
}

/** Everything a timer surface draws. */
export interface PomodoroState {
  running: Pomodoro | null;
  /** When the break a counted pomodoro earned ends; null when there is none. */
  breakEndsAt: string | null;
  /** The pomodoro that settled most recently, so a surface can say how it ended. */
  last: Pomodoro | null;
  /** Pomodoros that counted today (from the local midnight the caller passes). */
  todayCount: number;
  now: string;
}

/** Time left on a pomodoro's clock at `now` (ms): frozen at `remainingSec` while paused. */
export function pomodoroRemainingMs(p: Pomodoro, now: number): number {
  return p.pausedAt ? p.remainingSec * 1000 : Date.parse(p.endsAt) - now;
}

/** Fired after a pomodoro starts, settles or its break changes. Rows another device wrote
 *  arrive with the `data.changed` every sync emits. */
export const POMODORO_CHANGED_EVENT = "pomodoro.changed";

/** The start of today in this device's local time: the core may not know the user's zone. */
function dayStart(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** Typed wrapper over the pomodoro.* core methods. Every call answers with the new state. */
export function pomodoroApi(core: CoreBridge) {
  const call = (method: string, extra?: { taskId: string }) =>
    core.invoke<PomodoroState>(method, { ...extra, dayStart: dayStart() });
  return {
    /** The current state; settles a pomodoro whose fate is decided. */
    state: () => call("pomodoro.state"),
    /** Put a task in front of the pomodoro: the running one moves over to it (its clock keeps
     *  going), or a new one starts on it. */
    start: (taskId: string) => call("pomodoro.start", { taskId }),
    /** Finish the task the running pomodoro is on. It counts toward the pomodoro, whose clock
     *  stops until the next task is picked. */
    complete: () => call("pomodoro.complete"),
    /** Stop the running pomodoro's clock. */
    pause: () => call("pomodoro.pause"),
    /** Start it again (it needs a task in front of it). */
    resume: () => call("pomodoro.resume"),
    /** End the running pomodoro now — it counts, once a task was finished in it — and start the
     *  break. */
    finish: () => call("pomodoro.finish"),
    /** Give up the running pomodoro; it doesn't count. */
    cancel: () => call("pomodoro.cancel"),
    /** End the break early. */
    skipBreak: () => call("pomodoro.skipBreak"),
    onChanged: (cb: () => void) => core.on(POMODORO_CHANGED_EVENT, cb),
  };
}

export type PomodoroApi = ReturnType<typeof pomodoroApi>;
