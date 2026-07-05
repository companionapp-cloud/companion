import type { CoreBridge, TaskNotification } from "./types";

/** Typed wrapper over the notify.* core methods (PLAN §6.4). The plan is computed in Go
 *  from the live tasks; the shell schedules the fires per platform. */
export function notifyApi(core: CoreBridge) {
  return {
    /** Notifications due to fire over the next `horizonDays` (default 30), sorted by time. */
    plan: (horizonDays?: number) => core.invoke<TaskNotification[]>("notify.plan", { horizonDays }),
  };
}

export type NotifyApi = ReturnType<typeof notifyApi>;
