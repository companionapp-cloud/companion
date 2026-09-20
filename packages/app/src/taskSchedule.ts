import type { CreateTaskInput, Task } from "@companion/core-bridge";

// Where a task sits in time (PLAN-scheduling.md §5): the schedule views of the task lists —
// Anytime, Upcoming, Overdue, Someday — and the date groups Upcoming, Overdue and the Logbook
// are laid out in. Shared by every task list (global, per project and area, desktop and
// mobile) so the semantics never drift.

/** The schedule views a task list offers beside its membership scopes. */
export type ScheduleFilter = "anytime" | "upcoming" | "overdue" | "someday";

export function isScheduleFilter(f: string): f is ScheduleFilter {
  return f === "anytime" || f === "upcoming" || f === "overdue" || f === "someday";
}

/** Tasks filed away by something other than their own flag: the ids of those sitting in a
 *  Someday project. Inside that project's own list pass nothing, so they show normally. */
export type FiledAway = ReadonlySet<string> | undefined;

function time(iso?: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Filed under Someday — by its own flag, or along with its project. */
export function isSomeday(task: Task, filedAway?: FiledAway): boolean {
  return task.someday || !!filedAway?.has(task.id);
}

/** Overdue: its deadline has passed — or, with no deadline, its start date has (a start
 *  earlier today is not "passed": the day isn't over). */
export function isOverdue(task: Task, now: Date = new Date()): boolean {
  if (task.status !== "open") return false;
  const due = time(task.dueAt);
  if (due != null) return due < now.getTime();
  const start = time(task.startAt);
  return start != null && start < startOfDay(now).getTime();
}

/** Upcoming: scheduled (a start or a deadline) and not overdue — including a task already
 *  under way, whose start has passed but whose deadline hasn't. */
export function isUpcoming(task: Task, now: Date = new Date()): boolean {
  if (task.status !== "open") return false;
  return (time(task.startAt) != null || time(task.dueAt) != null) && !isOverdue(task, now);
}

/** Anytime: open, with neither a start nor a deadline. */
export function isAnytime(task: Task): boolean {
  return task.status === "open" && time(task.startAt) == null && time(task.dueAt) == null;
}

/** Narrow a task list to one schedule view. Someday tasks appear under "someday" and nowhere
 *  else; use `withoutSomeday` for the membership scopes (All, Unsorted, a list…). */
export function filterBySchedule(tasks: Task[], mode: ScheduleFilter, filedAway?: FiledAway, now: Date = new Date()): Task[] {
  if (mode === "someday") return tasks.filter((t) => t.status === "open" && isSomeday(t, filedAway));
  const live = withoutSomeday(tasks, filedAway);
  switch (mode) {
    case "anytime":
      return live.filter(isAnytime);
    case "upcoming":
      return live.filter((t) => isUpcoming(t, now));
    case "overdue":
      return live.filter((t) => isOverdue(t, now));
  }
}

/** Drop the tasks filed under Someday. Done ones stay: once finished, a task is history
 *  wherever it was filed. */
export function withoutSomeday(tasks: Task[], filedAway?: FiledAway): Task[] {
  return tasks.filter((t) => t.status !== "open" || !isSomeday(t, filedAway));
}

/** What a task added from a schedule view starts out with, so it lands in the view it was
 *  typed into: Someday files it away, Upcoming starts it tomorrow, Overdue — where there is
 *  no putting something new — starts it today. 9:00, like the editor's start presets. Every
 *  other view adds a plain task. */
export function newTaskDefaults(mode: string, now: Date = new Date()): Pick<CreateTaskInput, "startAt" | "someday"> {
  const at = (days: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 9, 0, 0, 0).toISOString();
  if (mode === "someday") return { someday: true };
  if (mode === "upcoming") return { startAt: at(1) };
  if (mode === "overdue") return { startAt: at(0) };
  return {};
}

/** The date a task is grouped under in Upcoming and Overdue: its start, else its deadline. */
export function scheduleDate(task: Task): Date | null {
  const t = time(task.startAt) ?? time(task.dueAt);
  return t == null ? null : new Date(t);
}

export interface DateGroup<T> {
  /** Stable per bucket: "today", "tomorrow", "yesterday", a day "2026-09-23", a month
   *  "2026-10", or a year "2027". */
  key: string;
  label: string;
  items: T[];
}

const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Group dated items the way Upcoming ("future") and Overdue / the Logbook ("past") read:
 *  Today, then Tomorrow (or Yesterday), then each other day of the current month, then each
 *  other month of the current year, then each other year — nearest first. A date on the wrong
 *  side of today (a task already under way, in Upcoming) counts as today. Items keep that
 *  nearest-first order within a group. */
export function groupByDate<T>(
  items: T[],
  dateOf: (item: T) => Date | null,
  direction: "future" | "past",
  now: Date = new Date(),
  /** "future" only: always lay out Today, Tomorrow and every remaining day of this month, empty
   *  or not, so Upcoming reads as a calendar of the days ahead rather than a bare list. */
  fillMonth = false,
): DateGroup<T>[] {
  const today = startOfDay(now);
  const sign = direction === "future" ? 1 : -1;
  const p = (n: number) => String(n).padStart(2, "0");
  // The bucket a (clamped) local day falls in.
  const bucket = (day: Date): { key: string; label: string } => {
    const diff = Math.round((day.getTime() - today.getTime()) / 86400000);
    if (diff === 0) return { key: "today", label: "Today" };
    if (diff === sign) return sign > 0 ? { key: "tomorrow", label: "Tomorrow" } : { key: "yesterday", label: "Yesterday" };
    if (day.getFullYear() === today.getFullYear() && day.getMonth() === today.getMonth()) {
      return { key: `${day.getFullYear()}-${p(day.getMonth() + 1)}-${p(day.getDate())}`, label: `${DAYS_SHORT[day.getDay()]} ${day.getDate()}` };
    }
    if (day.getFullYear() === today.getFullYear()) return { key: `${day.getFullYear()}-${p(day.getMonth() + 1)}`, label: MONTHS[day.getMonth()] };
    return { key: String(day.getFullYear()), label: String(day.getFullYear()) };
  };

  const dated = items
    .map((item) => {
      const raw = dateOf(item);
      let at = raw ?? now;
      if (sign * (startOfDay(at).getTime() - today.getTime()) < 0) at = now; // wrong side of today
      return { item, at };
    })
    .sort((a, b) => sign * (a.at.getTime() - b.at.getTime()));

  const groups: DateGroup<T>[] = [];
  const byKey = new Map<string, DateGroup<T>>();
  const groupFor = (day: Date) => {
    const { key, label } = bucket(day);
    let group = byKey.get(key);
    if (!group) {
      group = { key, label, items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    return group;
  };
  if (fillMonth && sign > 0) {
    // Today and Tomorrow always (Tomorrow even when it is next month's 1st), then the rest of
    // this month. Laid down first, in order, so the dated items below slot into them and the
    // months and years follow.
    const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const ahead = Math.max(1, lastDay - today.getDate());
    for (let i = 0; i <= ahead; i++) groupFor(new Date(today.getFullYear(), today.getMonth(), today.getDate() + i));
  }
  for (const { item, at } of dated) groupFor(startOfDay(at)).items.push(item);
  return groups;
}

/** A task list's date groups for a schedule view, or null when the view isn't grouped. */
export function scheduleGroups(tasks: Task[], mode: string, now: Date = new Date()): DateGroup<Task>[] | null {
  if (mode === "upcoming") return groupByDate(tasks, scheduleDate, "future", now, true);
  if (mode === "overdue") return groupByDate(tasks, scheduleDate, "past", now);
  return null;
}
