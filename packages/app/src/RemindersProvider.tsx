import { useEffect, useMemo, type ReactNode } from "react";
import type { TaskNotification } from "@companion/core-bridge";
import { useCore } from "./CoreContext";
import { activateReminder } from "./reminderNav";

/** A per-platform notification scheduler. The plan is computed in core (PLAN §6.4); the
 *  scheduler turns it into real OS fires. `reconcile` is cancel-and-reschedule: it is
 *  handed the *complete* current plan each time and must replace whatever it scheduled
 *  before. The shell injects the platform impl (Wails / expo-notifications); the default
 *  is a best-effort web `Notification` scheduler that no-ops where the API is absent. */
export interface NotificationScheduler {
  reconcile(plan: TaskNotification[]): void;
  /** Dismiss any *already-shown* notification for these task ids — used when a task is
   *  completed/removed so its lingering banner clears (PLAN §6.4). Pending fires are handled
   *  by `reconcile`; this is the delivered-notification counterpart. Optional. */
  dismiss?(taskIds: string[]): void;
}

/** Reconciles task reminders into scheduled notifications after every task change or sync
 *  (PLAN §6.4). Mount once inside CoreProvider.
 *
 *  `horizonDays` controls how far ahead fires are scheduled. Web/desktop keep the app
 *  running, so a 1-day horizon (the default) suffices — the plan re-arms as reminders
 *  approach. Mobile schedules OS-owned local notifications that fire while the app is
 *  killed, so it passes a longer horizon to cover reminders it may not reopen in time to
 *  arm (bounded by the scheduler's own cap, e.g. iOS's 64-notification limit). */
export function RemindersProvider({
  scheduler,
  horizonDays = 1,
  children,
}: {
  scheduler?: NotificationScheduler;
  horizonDays?: number;
  children: ReactNode;
}) {
  const { core, notify } = useCore();
  const sched = useMemo(() => scheduler ?? webNotificationScheduler(), [scheduler]);

  useEffect(() => {
    let cancelled = false;
    const reconcile = async () => {
      // Only fires within the horizon are scheduled; the plan is recomputed whenever tasks
      // change (and, on mobile, from a background refresh), so later reminders arm as they
      // approach.
      let plan: TaskNotification[];
      try {
        plan = await notify.plan(horizonDays);
      } catch {
        // Transient failure computing the plan: leave whatever is already scheduled in
        // place. Reconciling with [] here would tell a native scheduler to cancel every
        // pending OS notification — dropping a valid reminder over a momentary hiccup.
        return;
      }
      if (cancelled) return;
      sched.reconcile(plan);
      // Cancelling a *pending* fire is handled above (a settled task drops out of the plan).
      // Separately clear any notification that already surfaced for a task the user has since
      // completed/removed, so a stale banner doesn't linger (PLAN §6.4).
      if (sched.dismiss) {
        try {
          const ids = await notify.dismissed(horizonDays);
          if (!cancelled && ids.length) sched.dismiss(ids);
        } catch {
          // Best-effort; leave shown notifications as-is on a hiccup.
        }
      }
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
  }, [core, notify, sched, horizonDays]);

  return <>{children}</>;
}

/** Best-effort web scheduler: fires the browser `Notification` API via setTimeout while a
 *  tab is open (PLAN §6.4). The timers live in the page, so this only fires while a tab of
 *  the app is open — the web platform can't reliably deliver a local notification once the
 *  browser is closed. Multiple open tabs each schedule, but the `tag` collapses them to one
 *  visible notification per reminder.
 *
 *  When a service-worker `registration` is provided (the web shell registers one), fires go
 *  through `registration.showNotification` so a click is handled by the SW's
 *  `notificationclick` — which can refocus or reopen the app even if the tab that scheduled
 *  it has since closed — and routed back to `activateReminder` via a postMessage the shell
 *  wires up. Without a registration it falls back to `new Notification` + an inline onclick.
 *
 *  No-ops on platforms without the Notification API (e.g. React Native), so it stays a safe
 *  default everywhere — native shells inject their own scheduler instead. */
export function webNotificationScheduler(options?: { registration?: ServiceWorkerRegistration | null }): NotificationScheduler {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Notifications this scheduler has actually shown, keyed by taskId, so a completed task's
  // already-surfaced banner can be closed (the inline `new Notification` path only).
  const shown = new Map<string, Notification>();
  const NotificationCtor = typeof globalThis !== "undefined" ? (globalThis as { Notification?: typeof Notification }).Notification : undefined;
  const registration = options?.registration ?? null;
  const DAY_MS = 24 * 60 * 60 * 1000;

  const dismiss = (taskIds: string[]) => {
    for (const id of taskIds) {
      const n = shown.get(id);
      if (n) {
        try {
          n.close();
        } catch {
          /* already closed */
        }
        shown.delete(id);
      }
    }
    // Notifications shown by the service worker aren't in `shown`; close them via the SW.
    if (registration && taskIds.length) {
      const ids = new Set(taskIds);
      void registration.getNotifications().then((list) => {
        for (const n of list) if (n.tag && ids.has(n.tag)) n.close();
      });
    }
  };

  return {
    dismiss,
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
            if (NotificationCtor.permission !== "granted") return;
            if (registration) {
              // Shown by the SW so its notificationclick can reopen/focus the app; the SW
              // relays the taskId back to activateReminder (PLAN §6.4).
              void registration.showNotification(n.title, { body: n.body, tag: n.taskId, data: { taskId: n.taskId } });
              return;
            }
            const notification = new NotificationCtor(n.title, { body: n.body, tag: n.taskId });
            // Track it so a later completion of this task can dismiss the shown banner.
            shown.set(n.taskId, notification);
            notification.onclose = () => {
              if (shown.get(n.taskId) === notification) shown.delete(n.taskId);
            };
            // Tapping surfaces the tab and opens the reminder's task (PLAN §6.4).
            notification.onclick = () => {
              if (typeof window !== "undefined" && typeof window.focus === "function") window.focus();
              activateReminder({ taskId: n.taskId });
              notification.close();
            };
          }, delay),
        );
      }
    },
  };
}
