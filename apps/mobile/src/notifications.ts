// Mobile reminder scheduling + deep-linking (PLAN §6.4). Built on expo-notifications and
// injected into the shared RemindersProvider as a NotificationScheduler, mirroring how the
// sync notifier is injected — the shared packages stay free of the react-native dependency.
// The plan itself is computed in core; here we only turn it into scheduled local
// notifications and route a tap to the task it's about.

import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { SchedulableTriggerInputTypes } from 'expo-notifications';
import type { NotificationScheduler } from '@companion/app';
import type { TaskNotification } from '@companion/core-bridge';

// iOS keeps only the soonest 64 pending local notifications; cap below that so a burst of
// far-out reminders can't push out nearer ones. Android has no comparable hard limit but
// the same cap keeps behaviour consistent. The plan arrives sorted by fireAt ascending, so
// the cap keeps the soonest fires.
const MAX_SCHEDULED = 60;

// How far ahead reminders are scheduled. Longer than web/desktop (which stay running and
// re-arm continuously): mobile schedules OS-owned local notifications up front so they fire
// while the app is closed. Shared by the foreground provider and the background refresh so
// both compute the same plan window.
export const REMINDER_HORIZON_DAYS = 30;

// Present reminders as banners (with sound) even while the app is foregrounded — otherwise
// iOS silently routes them to Notification Center when the app is open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** The scheduler handed to RemindersProvider. reconcile() is cancel-and-reschedule: it
 *  clears every previously scheduled local notification and re-registers the current plan,
 *  matching the provider's contract of passing the complete plan each time. */
export function createMobileNotificationScheduler(): NotificationScheduler {
  // Ask once up front; Android also needs a channel for scheduled notifications to surface.
  const ready = ensureReminderPermission(true);
  // Serialize reconciles so a cancel + reschedule pass completes before the next starts.
  let queue: Promise<void> = Promise.resolve();

  return {
    reconcile(plan) {
      queue = queue.then(async () => {
        if (!(await ready)) return;
        await scheduleReminderPlan(plan);
      });
    },
  };
}

/** Cancel every scheduled reminder and re-register the plan as local notifications (capped
 *  for iOS). Assumes permission is already granted — used by both the foreground scheduler
 *  and the background refresh task, which share this so scheduling can't drift between them. */
export async function scheduleReminderPlan(plan: TaskNotification[]): Promise<void> {
  await Notifications.cancelAllScheduledNotificationsAsync().catch(() => {});
  const now = Date.now();
  const upcoming = plan
    .filter((n) => {
      const when = new Date(n.fireAt).getTime();
      return Number.isFinite(when) && when > now; // drop unparseable / already-past fires
    })
    .slice(0, MAX_SCHEDULED);
  for (const n of upcoming) {
    await Notifications.scheduleNotificationAsync({
      content: { title: n.title, body: n.body, data: { taskId: n.taskId } },
      trigger: { type: SchedulableTriggerInputTypes.DATE, date: new Date(n.fireAt).getTime() },
    }).catch(() => {});
  }
}

/** Ensure the Android channel exists and notification permission is granted. Pass
 *  prompt=false from background contexts so we never surface a permission dialog there —
 *  it just reports whether we may post. */
export async function ensureReminderPermission(prompt: boolean): Promise<boolean> {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('reminders', {
        name: 'Reminders',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    if (!prompt || !current.canAskAgain) return false;
    const requested = await Notifications.requestPermissionsAsync();
    return requested.granted;
  } catch {
    return false;
  }
}

/** The task a tapped reminder is about, or null. */
export function taskIdFromResponse(response: Notifications.NotificationResponse | null): string | null {
  const data = response?.notification?.request?.content?.data as { taskId?: unknown } | undefined;
  return typeof data?.taskId === 'string' && data.taskId ? data.taskId : null;
}
