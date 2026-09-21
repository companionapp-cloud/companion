import type { CalendarItem, CalendarItemKind, Task, UpdateTaskInput } from "@companion/core-bridge";
import { colors } from "@companion/design-system";

// Geometry and palette shared by the hour grids — the Calendar tool's week and the Today agenda's day:
// where a timed item sits in its day, and how concurrent ones split a column into lanes.

export const DAY_MIN = 24 * 60;

// Per-kind block palette. Events are ink (tinted by their feed color on the left bar), tasks
// read blue, dated notes take the success green — matching the legend and the agenda so a
// note reads the same everywhere. Roles, not ramp literals, so the blocks survive dark mode.
export const KIND: Record<CalendarItemKind, { bg: string; fg: string; bar: string }> = {
  event: { bg: colors.textPrimary, fg: colors.textInverse, bar: colors.textTertiary },
  task: { bg: colors.infoSoft, fg: colors.infoActive, bar: colors.info },
  note: { bg: colors.surfaceApp, fg: colors.textSecondary, bar: colors.success },
  project: { bg: colors.accentSoft, fg: colors.accentActive, bar: colors.accent },
};

/** Whether an item with an end sits inside one local day: it ends by the midnight that closes
 *  the day it starts on, and isn't that whole day. What fits is a block of time in an hour
 *  grid; what doesn't is a line in the all-day band of each day it covers. */
export function fitsInDay(item: Pick<CalendarItem, "startsAt" | "endsAt">): boolean {
  if (!item.endsAt) return true;
  const start = new Date(item.startsAt);
  const end = new Date(item.endsAt).getTime();
  const midnight = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
  const nextMidnight = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1).getTime();
  return end <= nextMidnight && !(start.getTime() === midnight && end === nextMidnight);
}

/** A point task — one with only a deadline, or only a start — has no length; it draws this long. */
export const POINT_MIN = 30;

/** What a task's block dropped at [startsAt, endsAt] writes back (PLAN-agenda.md): a task's
 *  block is its start → deadline, so a task that has both, or one just stretched into having
 *  a length, takes both; a point that was only moved keeps being a point on the date it had. */
export function taskBlockPatch(task: Pick<Task, "startAt" | "dueAt">, startsAt: string, endsAt: string, stretched: boolean): UpdateTaskInput {
  if (stretched || (task.startAt && task.dueAt)) return { startAt: startsAt, dueAt: endsAt };
  return task.dueAt ? { dueAt: startsAt } : { startAt: startsAt };
}

/** A timed item's span inside its day column, in minutes since local midnight. An item with
 *  no end reads as an hour; nothing draws shorter than `minMinutes` (half a row in the week
 *  grid; a quarter hour in the day grid, whose rows are tall enough to show one) or past midnight. */
export function spanOf(item: Pick<CalendarItem, "startsAt" | "endsAt">, minMinutes = 30): { start: number; end: number } {
  const s = new Date(item.startsAt);
  const start = s.getHours() * 60 + s.getMinutes();
  const mins = item.endsAt ? Math.max(minMinutes, (new Date(item.endsAt).getTime() - s.getTime()) / 60_000) : 60;
  return { start, end: Math.max(start + 15, Math.min(DAY_MIN, start + mins)) };
}

export type Lane = { lane: number; lanes: number };

/** Concurrency layout for one day. Sort by start, group into clusters of mutually overlapping
 *  blocks, give each block the first lane it fits in, and let the cluster's lane count set
 *  the width every block in it takes. */
export function layoutLanes(items: Pick<CalendarItem, "id" | "startsAt" | "endsAt">[], minMinutes = 30): Map<string, Lane> {
  const spans = items
    .map((item) => ({ id: item.id, ...spanOf(item, minMinutes) }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const out = new Map<string, Lane>();
  let cluster: typeof spans = [];
  let clusterEnd = -1;
  const flush = () => {
    const laneEnds: number[] = [];
    const placed: { id: string; lane: number }[] = [];
    for (const it of cluster) {
      let lane = laneEnds.findIndex((end) => end <= it.start);
      if (lane === -1) lane = laneEnds.push(it.end) - 1;
      else laneEnds[lane] = it.end;
      placed.push({ id: it.id, lane });
    }
    for (const p of placed) out.set(p.id, { lane: p.lane, lanes: laneEnds.length });
    cluster = [];
    clusterEnd = -1;
  };
  for (const it of spans) {
    if (cluster.length && it.start >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.end);
  }
  if (cluster.length) flush();
  return out;
}
