// Reminder activation: the seam between "a reminder notification was tapped" and "navigate
// to the task it's about" (PLAN §6.4). The tap arrives on each platform differently — a web
// `Notification` onclick, a Wails Go response relayed over the event stream, an
// expo-notifications response listener — but they all funnel through activateReminder, and
// whichever shell is mounted registers the one navigation handler that knows how to reach a
// task on that platform. Keeping it a tiny module-level registry avoids threading nav down
// into the platform notification schedulers (which live outside the navigator).

export type ReminderActivation = { taskId: string };

let handler: ((activation: ReminderActivation) => void) | null = null;
let pending: ReminderActivation | null = null;

/** Register the navigator that opens a task when a reminder is tapped. The shell calls this
 *  once from inside its navigation context; passing null clears it (on unmount). A tap that
 *  resolved before the navigator mounted (e.g. a cold open from a notification) is flushed
 *  the moment a handler registers. */
export function setReminderActivationHandler(h: ((activation: ReminderActivation) => void) | null): void {
  handler = h;
  if (h && pending) {
    const activation = pending;
    pending = null;
    h(activation);
  }
}

/** Route to the task a tapped reminder is about. If no handler is registered yet, buffer the
 *  latest activation so it fires as soon as the navigator mounts. */
export function activateReminder(activation: ReminderActivation): void {
  if (handler) handler(activation);
  else pending = activation;
}
