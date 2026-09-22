import type { Area, CalendarItem, Canvas, Note, Project, Task } from "@companion/core-bridge";
import type { IconName } from "@companion/design-system";
import type { TabRef } from "./nav-context";
import { isMacPlatform } from "./shortcuts";

// The command palette's model (PLAN §6.4): what it can do, how a query is matched against
// titles and dates, and how a hit becomes a row. Pure — the hook (useCommandPalette) feeds it
// the providers' data and the UI (CommandPalette) renders what comes back.

/** What a find command looks through. The `…Date` scopes read the query as a day ("friday",
 *  "sep 30") rather than as title text. */
export type PaletteScope = "all" | "note" | "task" | "taskDate" | "event" | "eventDate" | "project" | "projectDate" | "area";

export type PaletteCreateKind = "task" | "note" | "canvas" | "event";

/** Where the palette is: its command list, inside a find command, or filling in a new item. */
export type PaletteMode = { kind: "root" } | { kind: "find"; scope: PaletteScope } | { kind: "create"; what: PaletteCreateKind };

export type PaletteAction =
  /** Step into a find or create command. `seed` carries the text typed so far into it. */
  | { type: "mode"; mode: PaletteMode; seed?: string }
  /** Show something in the app. */
  | { type: "open"; ref: TabRef };

export interface PaletteItem {
  /** Unique within one result list. */
  key: string;
  section: string;
  icon: IconName;
  title: string;
  subtitle?: string;
  /** Mono metadata on the right: a date, a status. */
  trailing?: string;
  action: PaletteAction;
}

export interface PaletteCommand {
  id: string;
  label: string;
  /** Extra words the command answers to ("todo" finds "New task"). */
  keywords: string;
  icon: IconName;
  mode: PaletteMode;
  /** The letter of the command's own shortcut (⌥⇧ + it), shown beside it in the list. */
  shortcutKey?: string;
}

/** Every command, in the order the empty palette lists them: capture first — the palette is
 *  still quick capture, so ⏎ on open starts a task. New event is only listed once some calendar
 *  takes new events (see `rootItems`). */
export const PALETTE_COMMANDS: PaletteCommand[] = [
  { id: "new-task", label: "New task", keywords: "create add todo capture", icon: "tasks", mode: { kind: "create", what: "task" }, shortcutKey: "T" },
  { id: "new-note", label: "New note", keywords: "create add write capture", icon: "file", mode: { kind: "create", what: "note" }, shortcutKey: "N" },
  { id: "new-canvas", label: "New canvas", keywords: "create add board", icon: "canvas", mode: { kind: "create", what: "canvas" }, shortcutKey: "C" },
  { id: "new-event", label: "New event", keywords: "create add calendar meeting appointment schedule capture", icon: "calendar", mode: { kind: "create", what: "event" }, shortcutKey: "E" },
  { id: "find-all", label: "Find anything", keywords: "search open go to title", icon: "search", mode: { kind: "find", scope: "all" } },
  { id: "find-note", label: "Find a note", keywords: "search open notes title", icon: "file", mode: { kind: "find", scope: "note" } },
  { id: "find-task", label: "Find a task", keywords: "search open tasks todo title", icon: "tasks", mode: { kind: "find", scope: "task" } },
  { id: "find-task-date", label: "Find tasks by date", keywords: "search due deadline when day", icon: "tasks", mode: { kind: "find", scope: "taskDate" } },
  { id: "find-event", label: "Find a calendar event", keywords: "search open events meeting title", icon: "calendar", mode: { kind: "find", scope: "event" } },
  { id: "find-event-date", label: "Find calendar events by date", keywords: "search meeting when day agenda", icon: "calendar", mode: { kind: "find", scope: "eventDate" } },
  { id: "find-project", label: "Find a project", keywords: "search open projects title", icon: "folder", mode: { kind: "find", scope: "project" } },
  { id: "find-project-date", label: "Find projects by date", keywords: "search due deadline when day", icon: "folder", mode: { kind: "find", scope: "projectDate" } },
  { id: "find-area", label: "Find an area", keywords: "search open areas title", icon: "tag", mode: { kind: "find", scope: "area" } },
];

const SECTION_CREATE = "Create";
const SECTION_COMMANDS = "Commands";

/** The chip shown in the input while inside a command. */
export function modeLabel(mode: PaletteMode): string | null {
  if (mode.kind === "root") return null;
  if (mode.kind === "create") return CREATE_LABEL[mode.what];
  return SCOPE_LABEL[mode.scope];
}

const CREATE_LABEL: Record<PaletteCreateKind, string> = { task: "New task", note: "New note", canvas: "New canvas", event: "New event" };

const SCOPE_LABEL: Record<PaletteScope, string> = {
  all: "Anything",
  note: "Notes",
  task: "Tasks",
  taskDate: "Tasks by date",
  event: "Events",
  eventDate: "Events by date",
  project: "Projects",
  projectDate: "Projects by date",
  area: "Areas",
};

export function modePlaceholder(mode: PaletteMode): string {
  if (mode.kind === "root") return "Capture or find anything…";
  if (mode.kind === "create") return CREATE_PLACEHOLDER[mode.what];
  if (isDateScope(mode.scope)) return "A day — today, friday, sep 30…";
  return "Search by title…";
}

const CREATE_PLACEHOLDER: Record<PaletteCreateKind, string> = {
  task: "What do you need to do?",
  note: "Title",
  canvas: "Name the canvas",
  event: "What’s the event?",
};

export const isDateScope = (scope: PaletteScope) => scope === "taskDate" || scope === "eventDate" || scope === "projectDate";

// ---------------------------------------------------------------------------
// Title matching
// ---------------------------------------------------------------------------

const tokensOf = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);

/** How well `text` answers the query: 0 a prefix, 1 every word starts a word, 2 every word
 *  appears somewhere; null when a word is missing. */
export function matchRank(text: string, query: string): number | null {
  const tokens = tokensOf(query);
  if (tokens.length === 0) return 2;
  const hay = text.toLowerCase();
  if (!tokens.every((t) => hay.includes(t))) return null;
  if (hay.startsWith(tokens.join(" "))) return 0;
  const words = hay.split(/[^\p{L}\p{N}]+/u);
  return tokens.every((t) => words.some((w) => w.startsWith(t))) ? 1 : 2;
}

interface Ranked {
  item: PaletteItem;
  rank: number;
  /** Tie-break inside a rank: larger sorts first (recency, or an explicit priority). */
  weight: number;
}

const byRank = (a: Ranked, b: Ranked) => a.rank - b.rank || b.weight - a.weight || a.item.title.length - b.item.title.length;

const time = (iso?: string | null) => (iso ? new Date(iso).getTime() || 0 : 0);

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface PaletteData {
  notes: Note[];
  tasks: Task[];
  canvases: Canvas[];
  projects: Project[];
  areas: Area[];
}

const live = <T extends { deletedAt?: string | null; deletingAt?: string | null }>(rows: T[]) =>
  rows.filter((r) => !r.deletedAt && !r.deletingAt);

const untitled = (title: string, fallback: string) => title.trim() || fallback;

function noteItem(n: Note): PaletteItem {
  return {
    key: `note:${n.id}`,
    section: "Notes",
    icon: "file",
    title: untitled(n.title, "Untitled note"),
    trailing: n.date ? dayLabel(n.date.slice(0, 10)) : undefined,
    // A dated note is a daily note: it lives in the Today tool, on its day.
    action: { type: "open", ref: n.date ? { kind: "view", view: "today", date: n.date.slice(0, 10) } : { kind: "note", id: n.id } },
  };
}

function taskItem(t: Task): PaletteItem {
  const when = t.dueAt ? `due ${dayLabel(localDay(new Date(t.dueAt)))}` : t.startAt ? `starts ${dayLabel(localDay(new Date(t.startAt)))}` : undefined;
  return {
    key: `task:${t.id}`,
    section: "Tasks",
    icon: t.status === "open" ? "tasks" : "check",
    title: untitled(t.title, "Untitled task"),
    trailing: t.status === "open" ? when : t.status,
    action: { type: "open", ref: { kind: "task", id: t.id } },
  };
}

function canvasItem(c: Canvas): PaletteItem {
  return { key: `canvas:${c.id}`, section: "Canvases", icon: "canvas", title: untitled(c.name, "Untitled canvas"), action: { type: "open", ref: { kind: "canvas", id: c.id } } };
}

function projectItem(p: Project, areas: Area[]): PaletteItem {
  const when = p.dueAt ? `due ${dayLabel(localDay(new Date(p.dueAt)))}` : p.startAt ? `starts ${dayLabel(localDay(new Date(p.startAt)))}` : undefined;
  return {
    key: `project:${p.id}`,
    section: "Projects",
    icon: "folder",
    title: untitled(p.name, "Untitled project"),
    subtitle: areas.find((a) => a.id === p.areaId)?.name,
    trailing: p.completedAt ? "done" : when,
    action: { type: "open", ref: { kind: "project", projectId: p.id } },
  };
}

function areaItem(a: Area): PaletteItem {
  return { key: `area:${a.id}`, section: "Areas", icon: "tag", title: untitled(a.name, "Untitled area"), action: { type: "open", ref: { kind: "area", areaId: a.id } } };
}

const eventTime = (e: CalendarItem) => (e.allDay ? "all day" : new Date(e.startsAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));

export function eventItem(e: CalendarItem): PaletteItem {
  const day = eventDay(e);
  const at = eventTime(e);
  return {
    key: e.id,
    section: "Events",
    icon: "calendar",
    title: untitled(e.title, "Untitled event"),
    subtitle: e.location ?? undefined,
    trailing: `${dayLabel(day)} · ${at}`,
    // There is no event page: open the calendar on the event's week.
    action: { type: "open", ref: { kind: "view", view: "calendar", date: day } },
  };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const FIND_LIMIT = 30;
const ROOT_RESULT_LIMIT = 10;

/** Title hits for a scope, best first. An empty query lists what was touched most recently. */
export function findByTitle(scope: PaletteScope, query: string, data: PaletteData, events: CalendarItem[], limit = FIND_LIMIT): PaletteItem[] {
  const ranked: Ranked[] = [];
  const add = (title: string, weight: number, make: () => PaletteItem) => {
    const rank = matchRank(title, query);
    if (rank != null) ranked.push({ item: make(), rank, weight });
  };
  const wants = (s: PaletteScope) => scope === "all" || scope === s;
  if (wants("note")) for (const n of live(data.notes)) add(n.title, time(n.updatedAt), () => noteItem(n));
  // Open tasks before finished ones, whatever was touched last.
  if (wants("task")) for (const t of live(data.tasks)) add(t.title, time(t.updatedAt) - (t.status === "open" ? 0 : FINISHED_PENALTY), () => taskItem(t));
  if (scope === "all") for (const c of live(data.canvases)) add(c.name, time(c.updatedAt), () => canvasItem(c));
  if (wants("project")) {
    for (const p of data.projects.filter((p) => !p.deletedAt)) {
      add(p.name, time(p.updatedAt) - (p.completedAt ? FINISHED_PENALTY : 0), () => projectItem(p, data.areas));
    }
  }
  if (wants("area")) for (const a of data.areas.filter((a) => !a.deletedAt)) add(a.name, time(a.updatedAt), () => areaItem(a));
  if (wants("event")) {
    // With nothing typed, "recent" means nothing for events: list what is coming up instead.
    const now = Date.now();
    for (const e of nextOccurrences(events)) {
      const start = time(e.startsAt);
      if (!query.trim() && start < now) continue;
      // Upcoming first (soonest on top), then the past (latest on top).
      add(e.title, start >= now ? FAR - start : start - FAR, () => eventItem(e));
    }
  }
  ranked.sort(byRank);
  return (scope === "all" ? groupBySection(ranked) : ranked).slice(0, limit).map((r) => r.item);
}

// Searching everything, each kind keeps to its own section (capped, so one kind can't crowd out
// the rest). Sections are ordered by their best hit; a tie goes to this order.
const SECTION_ORDER = ["Notes", "Tasks", "Projects", "Areas", "Canvases", "Events"];
const PER_SECTION = 5;

function groupBySection(sorted: Ranked[]): Ranked[] {
  const sections = new Map<string, Ranked[]>();
  for (const r of sorted) {
    const rows = sections.get(r.item.section) ?? [];
    if (rows.length < PER_SECTION) rows.push(r);
    sections.set(r.item.section, rows);
  }
  return [...sections.values()]
    .sort((a, b) => a[0].rank - b[0].rank || SECTION_ORDER.indexOf(a[0].item.section) - SECTION_ORDER.indexOf(b[0].item.section))
    .flat();
}

// Larger than any timestamp, so a penalty or an inversion never crosses into another band.
const FAR = 1e14;
const FINISHED_PENALTY = FAR;

/** One row per event series: a weekly standup would otherwise fill the list. Keeps the next
 *  occurrence, or the latest one when the series is over. */
function nextOccurrences(events: CalendarItem[]): CalendarItem[] {
  const now = Date.now();
  const best = new Map<string, CalendarItem>();
  for (const e of events) {
    if (e.kind !== "event") continue;
    const key = `${e.feedId ?? ""}:${e.title}`;
    const cur = best.get(key);
    if (!cur) {
      best.set(key, e);
      continue;
    }
    const s = time(e.startsAt);
    const c = time(cur.startsAt);
    const better = c >= now ? s >= now && s < c : s > c;
    if (better) best.set(key, e);
  }
  return [...best.values()];
}

/** Tasks or projects that touch a day: starting on it, due on it, or running across it. With no
 *  day (nothing typed yet) it lists what is dated from today on, soonest first. */
export function findByDate(scope: "taskDate" | "projectDate", day: string | null, data: PaletteData, limit = FIND_LIMIT): PaletteItem[] {
  const today = localDay(new Date());
  type Dated = { startAt?: string | null; dueAt?: string | null };
  const daysOf = (d: Dated) => ({ start: d.startAt ? localDay(new Date(d.startAt)) : null, due: d.dueAt ? localDay(new Date(d.dueAt)) : null });
  const touches = (d: Dated): string | null => {
    const { start, due } = daysOf(d);
    if (!start && !due) return null;
    if (day) {
      if (start === day || due === day) return day;
      return start && due && start < day && day < due ? day : null;
    }
    // Upcoming: sorted by the first of its dates that hasn't passed.
    const next = [start, due].filter((x): x is string => !!x && x >= today).sort()[0];
    return next ?? null;
  };
  const out: { item: PaletteItem; at: string }[] = [];
  if (scope === "taskDate") {
    for (const t of live(data.tasks)) {
      if (t.status !== "open") continue;
      const at = touches(t);
      if (at) out.push({ item: { ...taskItem(t), section: sectionForDay(day, at) }, at });
    }
  } else {
    for (const p of data.projects) {
      if (p.deletedAt || p.completedAt) continue;
      const at = touches(p);
      if (at) out.push({ item: { ...projectItem(p, data.areas), section: sectionForDay(day, at) }, at });
    }
  }
  return out
    .sort((a, b) => a.at.localeCompare(b.at) || a.item.title.localeCompare(b.item.title))
    .slice(0, limit)
    .map((o) => o.item);
}

/** A day's events, in order. `items` is that day's `calendar.range`. */
export function eventsOnDay(items: CalendarItem[], day: string | null): PaletteItem[] {
  return items
    .filter((e) => e.kind === "event")
    // The section already names the day; the row only needs the time.
    .map((e) => ({ ...eventItem(e), section: sectionForDay(day, eventDay(e)), trailing: eventTime(e) }));
}

const sectionForDay = (asked: string | null, at: string) => (asked ? dayLabel(asked, true) : dayLabel(at, true));

/** The root list: commands answering the query, then title hits across everything, then the
 *  create rows carrying the typed text. Empty, it is just the command list. Events are only
 *  offered with `canCreateEvent`: some calendar takes new ones. */
export function rootItems(query: string, data: PaletteData, events: CalendarItem[], { canCreateEvent = false } = {}): PaletteItem[] {
  const q = query.trim();
  const offered = (what: PaletteCreateKind) => what !== "event" || canCreateEvent;
  const commands = PALETTE_COMMANDS.filter((c) => c.mode.kind !== "create" || offered(c.mode.what))
    .map((c) => ({ c, rank: q ? matchRank(`${c.label} ${c.keywords}`, q) : 2 }))
    .filter((x): x is { c: PaletteCommand; rank: number } => x.rank != null)
    .sort((a, b) => a.rank - b.rank)
    .map(({ c }) => commandItem(c));
  if (!q) return commands;
  const create: PaletteItem[] = (["task", "note", "canvas", "event"] as const).filter(offered).map((what) => ({
    key: `create:${what}`,
    section: SECTION_CREATE,
    icon: "plus" as IconName,
    title: `New ${what} “${q}”`,
    action: { type: "mode", mode: { kind: "create", what }, seed: q },
  }));
  return [...commands, ...findByTitle("all", q, data, events, ROOT_RESULT_LIMIT), ...create];
}

function commandItem(c: PaletteCommand): PaletteItem {
  const trailing = c.shortcutKey ? (isMacPlatform() ? `⌥⇧${c.shortcutKey}` : `alt ⇧ ${c.shortcutKey}`) : undefined;
  return { key: c.id, section: SECTION_COMMANDS, icon: c.icon, title: c.label, trailing, action: { type: "mode", mode: c.mode } };
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

/** 'YYYY-MM-DD' in the viewer's timezone. */
export function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The local day an event falls on. An all-day event carries a date marker (midnight UTC), so
 *  its date portion is the day — converting the instant would shift it in some zones. */
export function eventDay(e: CalendarItem): string {
  return e.allDay ? e.startsAt.slice(0, 10) : localDay(new Date(e.startsAt));
}

/** The ISO instants bounding a local day, for `calendar.range`. */
export function dayBounds(day: string): { from: string; to: string } {
  const [y, m, d] = day.split("-").map(Number);
  return { from: new Date(y, m - 1, d).toISOString(), to: new Date(y, m - 1, d + 1).toISOString() };
}

/** "Today", "Tomorrow", or "Fri, Sep 25" (with the year once it isn't this one). */
export function dayLabel(day: string, long = false): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const now = new Date();
  const diff = Math.round((date.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: long ? "long" : "short",
    month: "short",
    day: "numeric",
    year: y === now.getFullYear() ? undefined : "numeric",
  });
}
