// Reminder presets and human-readable labels for the task editor (PLAN §6.4). The core is the
// source of truth for reminders — parsing typed ones (tasks.parseReminder), normalizing the
// list, and resolving when each fires — so this is only the one-tap presets the UI offers and a
// label that makes a stored reminder read as words.
import type { TaskReminder } from "@companion/core-bridge";

/** One "before the deadline" preset: the words it's offered as, and the lead it stores. */
export interface ReminderLeadPreset {
  label: string;
  before: string;
}

/** The lead presets, in the order they fire. "Few" is three days but two weeks — three weeks
 *  would sit almost on the month preset (the same rule core's phrase parser uses). */
export const REMINDER_LEAD_PRESETS: ReminderLeadPreset[] = [
  { label: "Month before", before: "P1M" },
  { label: "Few weeks before", before: "P2W" },
  { label: "Week before", before: "P1W" },
  { label: "Few days before", before: "P3D" },
  { label: "Day before", before: "P1D" },
  { label: "At deadline", before: "PT0M" },
];

/** At most this many reminders per task (mirrors core/domain.MaxReminders). */
export const MAX_REMINDERS = 10;

const LEAD_UNITS: Record<string, [string, string]> = {
  MINUTE: ["minute", "minutes"],
  H: ["hour", "hours"],
  D: ["day", "days"],
  W: ["week", "weeks"],
  MONTH: ["month", "months"],
};

/** A reminder as words: a lead reads "3 days before" (or "At deadline"); an instant reads
 *  "Oct 9, 9:00 AM" (with the year when it isn't this year's). */
export function reminderLabel(r: TaskReminder): string {
  if (r.at) return formatInstant(r.at);
  const m = /^P(?:(\d+)([DWM])|T(\d+)([HM]))$/i.exec((r.before ?? "").trim());
  if (!m) return r.before ?? "";
  const n = Number(m[1] ?? m[3]);
  if (n === 0) return "At deadline";
  // The date part's M is months; the time part's M is minutes.
  const unit = m[1] ? (m[2].toUpperCase() === "M" ? "MONTH" : m[2].toUpperCase()) : m[4].toUpperCase() === "M" ? "MINUTE" : "H";
  const [one, many] = LEAD_UNITS[unit];
  return `${n} ${n === 1 ? one : many} before`;
}

/** The chip summary for a task's reminders: nothing, the one reminder, or a count. */
export function remindersSummary(reminders: TaskReminder[] | undefined): string | null {
  const list = reminders ?? [];
  if (list.length === 0) return null;
  if (list.length === 1) return reminderLabel(list[0]);
  return `${list.length} reminders`;
}

/** Whether two reminders are the same one (the list is normalized in core, so leads compare
 *  as canonical strings and instants as timestamps). */
export function sameReminder(a: TaskReminder, b: TaskReminder): boolean {
  if (a.at || b.at) return !!a.at && !!b.at && new Date(a.at).getTime() === new Date(b.at).getTime();
  return (a.before ?? "").toUpperCase() === (b.before ?? "").toUpperCase();
}

function formatInstant(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return `${d.toLocaleDateString(undefined, opts)}, ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}
