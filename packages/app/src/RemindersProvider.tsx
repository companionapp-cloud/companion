import { useEffect, useMemo, type ReactNode } from "react";
import type { TaskNotification } from "@companion/core-bridge";
import { useCore } from "./CoreContext";

/** A per-platform notification scheduler. The plan is computed in core (PLAN §6.4); the
 *  scheduler turns it into real OS fires. `reconcile` is cancel-and-reschedule: it is
 *  handed the *complete* current plan each time and must replace whatever it scheduled
 *  before. The shell injects the platform impl (Wails / expo-notifications); the default
 *  is a best-effort web `Notification` scheduler that no-ops where the API is absent. */
export interface NotificationScheduler {
  reconcile(plan: TaskNotification[]): void;
}

/** Reconciles task reminders into scheduled notifications after every task change or sync
 *  (PLAN §6.4). Mount once inside CoreProvider. */
export function RemindersProvider({ scheduler, children }: { scheduler?: NotificationScheduler; children: ReactNode }) {
  const { core, notify } = useCore();
  const sched = useMemo(() => scheduler ?? webNotificationScheduler(), [scheduler]);

  useEffect(() => {
    let cancelled = false;
    const reconcile = async () => {
      // A 1-day horizon: only near-term fires are scheduled while the app is running; the
      // plan is recomputed whenever tasks change, so later reminders arm as they approach.
      const plan = await notify.plan(1).catch(() => [] as TaskNotification[]);
      if (!cancelled) sched.reconcile(plan);
    };
    void reconcile();
    const offTasks = core.on("tasks.changed", () => void reconcile());
    const offData = core.on("data.changed", () => void reconcile());
    return () => {
      cancelled = true;
      offTasks();
      offData();
      sched.reconcile([]); // clear on unmount
    };
  }, [core, notify, sched]);

  return <>{children}</>;
}

/** Best-effort web scheduler: fires the browser `Notification` API via setTimeout while a
 *  tab is open (PLAN §6.4). No-ops on platforms without the API (e.g. React Native), so it
 *  is a safe default everywhere — native shells inject their own scheduler instead. */
export function webNotificationScheduler(): NotificationScheduler {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const NotificationCtor = typeof globalThis !== "undefined" ? (globalThis as { Notification?: typeof Notification }).Notification : undefined;
  const DAY_MS = 24 * 60 * 60 * 1000;

  return {
    reconcile(plan) {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      if (!NotificationCtor) return;
      if (plan.length && NotificationCtor.permission === "default") void NotificationCtor.requestPermission();

      const now = Date.now();
      for (const n of plan) {
        const delay = new Date(n.fireAt).getTime() - now;
        if (delay < 0 || delay > DAY_MS) continue; // only near-term, in-window fires
        const key = `${n.taskId}:${n.fireAt}`;
        timers.set(
          key,
          setTimeout(() => {
            if (NotificationCtor.permission === "granted") new NotificationCtor(n.title, { body: n.body });
          }, delay),
        );
      }
    },
  };
}
