import { useCallback, useEffect, useRef, useState } from "react";
import type { PomodoroState } from "@companion/core-bridge";
import { useCore } from "../CoreContext";

// Events after which the pomodoro state may have moved: its own, a task finished or trashed
// anywhere (finishing the task is what makes a pomodoro count), and a sync pulling rows in.
const REFRESH_EVENTS = ["pomodoro.changed", "tasks.changed", "data.changed"];

/** The pomodoro state, kept current, plus a clock that ticks once a second while a pomodoro or
 *  break is on (for countdowns). `now` is corrected by the core's clock, so a countdown agrees
 *  with when the core settles. */
export function usePomodoro(enabled = true) {
  const { core, pomodoro } = useCore();
  const [state, setState] = useState<PomodoroState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // The core's clock minus ours, from the last state.
  const skew = useRef(0);

  const apply = useCallback((next: PomodoroState) => {
    skew.current = Date.parse(next.now) - Date.now();
    setNow(Date.now() + skew.current);
    setState(next);
  }, []);

  const refresh = useCallback(() => {
    pomodoro.state().then(apply, (err) => console.warn("pomodoro: state", err));
  }, [pomodoro, apply]);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    // Events come in bursts (a task update emits several); one read answers them all.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 100);
    };
    const offs = REFRESH_EVENTS.map((name) => core.on(name, schedule));
    return () => {
      if (timer) clearTimeout(timer);
      offs.forEach((off) => off());
    };
  }, [core, enabled, refresh]);

  // What the clock is counting toward — nothing while a pomodoro's clock is stopped.
  const endsAt = state?.running
    ? state.running.pausedAt
      ? null
      : Date.parse(state.running.endsAt)
    : state?.breakEndsAt
      ? Date.parse(state.breakEndsAt)
      : null;
  useEffect(() => {
    if (!enabled || endsAt == null) return;
    const id = setInterval(() => {
      const t = Date.now() + skew.current;
      setNow(t);
      // Ran out: ask the core, which settles it (expired, or the break over).
      if (t >= endsAt) refresh();
    }, 1000);
    return () => clearInterval(id);
  }, [enabled, endsAt, refresh]);

  return { state, now, apply, refresh };
}
