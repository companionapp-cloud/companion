import type { CoreBridge, NotificationFeedItem, TaskNotification } from "./types";

/** Typed wrapper over the notify.* core methods (PLAN §6.4). The plan is computed in Go
 *  from the live tasks; the shell schedules the fires per platform. */
export function notifyApi(core: CoreBridge) {
  return {
    /** Notifications due to fire over the next `horizonDays` (default 30), sorted by time. */
    plan: (horizonDays?: number) => core.invoke<TaskNotification[]>("notify.plan", { horizonDays }),
    /** Ids of settled tasks (done/cancelled/trashed) whose reminder already fired — the shell
     *  dismisses any notification still showing for them. Pending fires are cancelled via
     *  re-planning; this clears already-surfaced ones (PLAN §6.4). */
    dismissed: (horizonDays?: number) => core.invoke<string[]>("notify.dismissed", { horizonDays }),
    /** The in-app notification feed: fires from the trailing `lookbackDays` (default 14),
     *  newest first, each flagged read/unread (PLAN §6.4). */
    feed: (lookbackDays?: number) => core.invoke<NotificationFeedItem[]>("notify.feed", { lookbackDays }),
    /** Mark one feed item read; the receipt syncs so it reads as read on every device. */
    markRead: (taskId: string, fireAt: string) => core.invoke<{ ok: boolean }>("notify.markRead", { taskId, fireAt }),
    /** Mark every currently-unread feed item read. */
    markAllRead: (lookbackDays?: number) => core.invoke<{ ok: boolean }>("notify.markAllRead", { lookbackDays }),
  };
}

export type NotifyApi = ReturnType<typeof notifyApi>;
