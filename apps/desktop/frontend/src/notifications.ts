import type { NotificationScheduler } from "@companion/app";

// Desktop reminder scheduler (PLAN §6.4). The Wails webview has no browser Notification
// API, so instead of the shared web fallback we hand the plan to the Go side, which
// registers real OS notifications through the Wails v3 notifications service (see
// apps/desktop/notifications.go). reconcile() is cancel-and-reschedule: the Go handler
// clears every pending fire and re-registers the current plan on each call.
export function desktopNotificationScheduler(): NotificationScheduler {
  // Ask for permission once, up front on launch — surfacing the OS prompt immediately
  // rather than waiting for the first reminder to come due. Resolves to the grant state.
  const authorization = requestAuthorization();
  // Serialize reconciles so authorization + each schedule finishes before the next one
  // starts — otherwise a rapid change burst could reorder clear-then-schedule.
  let queue: Promise<void> = Promise.resolve();

  return {
    reconcile(plan) {
      queue = queue.then(async () => {
        if (!(await authorization)) return;
        await fetch("/notify/reconcile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(plan),
        }).catch(() => {});
      });
    },
  };
}

async function requestAuthorization(): Promise<boolean> {
  try {
    const res = await fetch("/notify/authorize", { method: "POST" });
    if (!res.ok) return false;
    const { granted } = (await res.json()) as { granted?: boolean };
    return !!granted;
  } catch {
    return false;
  }
}
