// Background reminder refresh (PLAN §6.4, mobile Option B). Local notifications this device
// already scheduled fire on their own while the app is closed; this task exists to catch
// reminders *created on other devices*. The OS wakes us periodically (iOS BGTaskScheduler,
// Android WorkManager) to pull a sync and re-arm the local notifications from the fresh
// plan. Timing is best-effort — the system decides when — but each run brings the schedule
// up to date.
//
// The task MUST be defined at module scope (import side effect), so importing this file
// registers it; call registerReminderRefresh() once at startup to schedule the periodic run.

import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';
import { notifyApi } from '@companion/core-bridge';
import { openCore } from './core';
import { syncOnce } from './sync';
import { ensureReminderPermission, scheduleReminderPlan, REMINDER_HORIZON_DAYS } from './notifications';

const REMINDER_REFRESH_TASK = 'companion.reminders.refresh';
// Best-effort cadence; the OS treats it as a floor and coalesces wakeups (min 15 min).
const MINIMUM_INTERVAL_MINUTES = 15;

TaskManager.defineTask(REMINDER_REFRESH_TASK, async () => {
  try {
    // Never prompt from the background; only proceed if the user already granted.
    if (!(await ensureReminderPermission(false))) {
      return BackgroundTask.BackgroundTaskResult.Success;
    }
    const core = openCore();
    await syncOnce(core); // pull reminders created on other devices
    const plan = await notifyApi(core).plan(REMINDER_HORIZON_DAYS);
    await scheduleReminderPlan(plan); // re-arm local notifications from the fresh plan
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/** Register the periodic refresh. Idempotent — safe to call on every startup. No-op where
 *  background tasks are unavailable (e.g. the OS restricted them or web). */
export async function registerReminderRefresh(): Promise<void> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) return;
    await BackgroundTask.registerTaskAsync(REMINDER_REFRESH_TASK, {
      minimumInterval: MINIMUM_INTERVAL_MINUTES,
    });
  } catch {
    /* registration is best-effort; foreground scheduling still works without it */
  }
}
