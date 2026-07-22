import { Platform } from 'react-native';
import { ExtensionStorage } from '@bacons/apple-targets';
import type { CalendarItem, Project, Task } from '@companion/core-bridge';
import { updateWatchContext } from '../modules/watch-bridge';

// The phone is the source of truth. On every task/project change we recompute a snapshot and
// ship it to the watch over WatchConnectivity (App Groups don't cross devices — see
// targets/watch/README.md). The watch renders Today / Upcoming / Overdue / per-project lists
// and can send "create task" back the other way.

// The phone's own same-device App Group (for a future iOS widget). MUST match `group.` in app.json.
export const WATCH_APP_GROUP = 'group.cloud.companion.app';

// Per-list caps — a watch never needs the full backlog; overflow is reported via meta counts.
const MAX_LIST = 50;
const MAX_PROJECTS = 30;

const storage = new ExtensionStorage(WATCH_APP_GROUP);

// Flat, scalar-only task record. Dates are pre-formatted and pre-sorted so the watch never has
// to parse a timestamp or know the user's locale.
export interface WatchTaskRecord {
  [key: string]: string | number;
  id: string;
  title: string;
  dueLabel: string;
  overdue: number; // 0 | 1 (past its due time) — for red styling on the watch
  sortKey: number; // due timestamp (ms), or Number.MAX_SAFE_INTEGER when undated (sorts last)
}

interface WatchProjectRecord {
  id: string;
  name: string;
  tasks: WatchTaskRecord[];
}

// Flat, scalar-only calendar-event record (same rationale as WatchTaskRecord).
export interface WatchEventRecord {
  [key: string]: string | number;
  id: string;
  title: string;
  whenLabel: string; // "Today · 2:00 PM" / "Tue · 9:00 AM" / "Aug 3 · All day"
  startKey: number; // start timestamp (ms), for ordering
  allDay: number; // 0 | 1
}

export interface WatchSnapshot {
  today: WatchTaskRecord[];
  upcoming: WatchTaskRecord[];
  overdue: WatchTaskRecord[];
  someday: WatchTaskRecord[];
  projects: WatchProjectRecord[];
  events: WatchEventRecord[];
  meta: {
    updatedAt: string;
    todayCount: number;
    upcomingCount: number;
    overdueCount: number;
    somedayCount: number;
    eventCount: number; // events happening today (for the root badge)
  };
}

function startOfToday(now: Date): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function endOfToday(now: Date): number {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

// End-of-day (23:59:59.999) is our "due this day, no specific time" marker — what a watch
// quick-add stamps. Such tasks read as the day itself, not a literal "11:59 PM".
function isAllDay(due: Date): boolean {
  return due.getHours() === 23 && due.getMinutes() === 59 && due.getSeconds() === 59;
}

function formatDueLabel(dueMs: number | null, now: Date): string {
  if (dueMs == null) return ''; // undated — the row shows no due label
  const due = new Date(dueMs);
  const sameDay = due.toDateString() === now.toDateString();
  const allDay = isAllDay(due);
  const past = dueMs < now.getTime();
  if (sameDay) {
    if (allDay) return 'Today';
    const time = due.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return past ? `Overdue · ${time}` : time;
  }
  const date = due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return past && !allDay ? `Overdue · ${date}` : date;
}

/** A short human label for a detected due date, for the watch's live Add-Task preview:
 *  "Today" / "Tomorrow · 3:00 PM" / "Fri · 9:00 AM" / "Aug 3". Times are dropped for
 *  midnight / all-day markers. */
export function formatDuePreview(iso: string, now: Date = new Date()): string {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  const day = dayPart(ms, now);
  const noTime = isAllDay(d) || (d.getHours() === 0 && d.getMinutes() === 0);
  if (noTime) return day;
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time}`;
}

/** dueAt (ISO) for a watch quick-add, end of the chosen day — the "due today/tomorrow" marker. */
export function watchDueAt(mode: 'today' | 'tomorrow', now: Date = new Date()): string {
  const d = new Date(now);
  if (mode === 'tomorrow') d.setDate(d.getDate() + 1);
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

// A short "which day" label relative to today: Today / Tomorrow / weekday (this week) / date.
function dayPart(ms: number, now: Date): string {
  const target = new Date(ms);
  target.setHours(0, 0, 0, 0);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays > 1 && diffDays < 7) return new Date(ms).toLocaleDateString(undefined, { weekday: 'short' });
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatEventWhen(startMs: number, allDay: boolean, now: Date): string {
  if (Number.isNaN(startMs)) return '';
  const day = dayPart(startMs, now);
  if (allDay) return `${day} · All day`;
  const time = new Date(startMs).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time}`;
}

function toEventRecord(e: CalendarItem, now: Date): WatchEventRecord {
  const start = new Date(e.startsAt).getTime();
  return {
    id: e.id, // unique per merged item (distinct across recurring occurrences)
    title: e.title || 'Untitled event',
    whenLabel: formatEventWhen(start, e.allDay, now),
    startKey: Number.isNaN(start) ? 0 : start,
    allDay: e.allDay ? 1 : 0,
  };
}

function toRecord(t: Task, now: Date): WatchTaskRecord {
  const dueMs = t.dueAt ? new Date(t.dueAt).getTime() : NaN;
  const hasDue = !Number.isNaN(dueMs);
  return {
    id: t.id,
    title: t.title || 'Untitled task',
    dueLabel: formatDueLabel(hasDue ? dueMs : null, now),
    overdue: hasDue && dueMs < now.getTime() ? 1 : 0,
    sortKey: hasDue ? dueMs : Number.MAX_SAFE_INTEGER,
  };
}

const byDue = (a: WatchTaskRecord, b: WatchTaskRecord) => a.sortKey - b.sortKey;
const isOpen = (t: Task) => t.status === 'open';

/**
 * Build the watch snapshot. Date buckets are disjoint by day boundary: overdue = due before
 * today, today = due today, upcoming = due after today (undated tasks appear only under their
 * projects). `membersByProject` maps a project id to the set of task ids assigned to it.
 * `events` is the merged calendar for the window the caller queried (calendar kind only).
 */
export function buildWatchSnapshot(
  tasks: Task[],
  projects: Project[],
  membersByProject: Map<string, Set<string>>,
  events: CalendarItem[],
  now: Date = new Date(),
): WatchSnapshot {
  const dayStart = startOfToday(now);
  const dayEnd = endOfToday(now);

  const overdue: WatchTaskRecord[] = [];
  const today: WatchTaskRecord[] = [];
  const upcoming: WatchTaskRecord[] = [];
  const someday: WatchTaskRecord[] = []; // open tasks with no (valid) due date

  for (const t of tasks) {
    if (!isOpen(t)) continue;
    const due = t.dueAt ? new Date(t.dueAt).getTime() : NaN;
    if (Number.isNaN(due)) {
      someday.push(toRecord(t, now));
      continue;
    }
    const rec = toRecord(t, now);
    if (due < dayStart) overdue.push(rec);
    else if (due <= dayEnd) today.push(rec);
    else upcoming.push(rec);
  }
  overdue.sort(byDue);
  today.sort(byDue);
  upcoming.sort(byDue);
  someday.sort((a, b) => a.title.localeCompare(b.title));

  const openById = new Map(tasks.filter(isOpen).map((t) => [t.id, t]));
  const projectRecords: WatchProjectRecord[] = [];
  for (const p of projects) {
    if (p.archivedAt) continue;
    const memberIds = membersByProject.get(p.id);
    if (!memberIds) continue;
    const ptasks: WatchTaskRecord[] = [];
    for (const id of memberIds) {
      const t = openById.get(id);
      if (t) ptasks.push(toRecord(t, now));
    }
    if (ptasks.length === 0) continue; // skip empty projects — nothing to show on the wrist
    ptasks.sort(byDue);
    projectRecords.push({ id: p.id, name: p.name, tasks: ptasks.slice(0, MAX_LIST) });
  }

  const eventRecords = events
    .filter((e) => e.kind === 'event')
    .map((e) => toEventRecord(e, now))
    .sort((a, b) => a.startKey - b.startKey);
  const eventCount = eventRecords.filter((e) => e.startKey >= dayStart && e.startKey <= dayEnd).length;

  return {
    today: today.slice(0, MAX_LIST),
    upcoming: upcoming.slice(0, MAX_LIST),
    overdue: overdue.slice(0, MAX_LIST),
    someday: someday.slice(0, MAX_LIST),
    projects: projectRecords.slice(0, MAX_PROJECTS),
    events: eventRecords.slice(0, MAX_LIST),
    meta: {
      updatedAt: now.toISOString(),
      todayCount: today.length,
      upcomingCount: upcoming.length,
      overdueCount: overdue.length,
      somedayCount: someday.length,
      eventCount,
    },
  };
}

/** Send a snapshot to the watch (WCSession) and mirror Today into the phone App Group (future
 *  iOS widget). No-op off iOS. */
export function sendWatchSnapshot(snapshot: WatchSnapshot): void {
  if (Platform.OS !== 'ios') return;

  // (1) Cross-device: hand the full snapshot to the watch over WCSession.
  updateWatchContext(snapshot as unknown as Record<string, unknown>);

  // (2) Same-device: mirror Today into the phone's App Group for a future iOS widget.
  try {
    storage.set('today.tasks', snapshot.today);
    storage.set('today.meta', {
      updatedAt: snapshot.meta.updatedAt,
      openCount: snapshot.meta.todayCount,
    });
  } catch {
    // Best-effort: a failed write just leaves any widget on its last-known snapshot.
  }
}
