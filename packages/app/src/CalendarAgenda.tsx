import { useEffect, useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import type { CalendarItem, CalendarItemKind, Task } from "@companion/core-bridge";
import {
  Button,
  Icon,
  IconButton,
  Input,
  Text,
  colors,
  control,
  icon,
  motion,
  noSelect,
  radius,
  row,
  space,
  transition,
  useDensity,
  type IconName,
  type PressState,
} from "@companion/design-system";
import { AgendaGrid, clockLabel, type GridBlock, type GridDrop } from "./AgendaGrid";
import { AgendaPalette } from "./AgendaPalette";
import { useCalendar } from "./CalendarProvider";
import { DAY_MIN, POINT_MIN, fitsInDay, taskBlockPatch } from "./calendarLayout";
import { refPayload, useRefDrag, type DragPayload } from "./DndContext";
import { EventEditorDialog, type EventEditorTarget } from "./EventEditorDialog";
import { useTasks } from "./TasksProvider";
import { contextMenuProps, type MenuEntry } from "./contextMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { useItemMenus } from "./ItemMenus";

/** The local calendar day ('YYYY-MM-DD') an item falls on. All-day items (dated notes,
 *  all-day events) carry a date-only marker stored as midnight UTC; converting that instant
 *  to local time would shift it a day in some zones, so their date portion is used directly.
 *  Timed items use their instant in the user's timezone. */
export function itemDay(item: CalendarItem): string {
  if (item.allDay) return item.startsAt.slice(0, 10);
  return localDay(new Date(item.startsAt));
}

/** Whether an item belongs in a day's all-day band: an all-day event or dated note, or
 *  anything with a start and an end that doesn't fit inside one day — a task or project running
 *  from its start to its deadline (PLAN-scheduling.md §4), an event that runs past midnight.
 *  What does fit is a block of time, a task's start → deadline included (PLAN-agenda.md). */
export function isAllDay(item: CalendarItem): boolean {
  return item.allDay || !fitsInDay(item);
}

/** Every local day ('YYYY-MM-DD') an item that doesn't fit in one covers, first to last: from
 *  the day it starts to the day it ends, in the viewer's timezone. Any other item covers just
 *  its `itemDay`. */
export function itemDays(item: CalendarItem): string[] {
  if (item.allDay || !item.endsAt || fitsInDay(item)) return [itemDay(item)];
  const start = new Date(item.startsAt);
  const last = localDay(new Date(item.endsAt));
  const days: string[] = [];
  // Bounded: a project can run for years, and no caller looks further than a few weeks.
  for (let i = 0; i < 3660; i++) {
    const day = localDay(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
    days.push(day);
    if (day >= last) break;
  }
  return days;
}

// Per-kind accent for the touch agenda dot (PLAN §6.7). Events lean neutral, tasks read blue,
// dated notes read green — one glance tells you what a line is.
const KIND_COLOR: Record<CalendarItemKind, string> = {
  event: colors.textTertiary,
  task: colors.info,
  note: colors.success,
  project: colors.accent,
};
// The pointer agenda swaps the dot for a quiet 12px glyph: the shape says what a line is, and
// colour is left for a feed's own swatch.
const KIND_ICON: Record<CalendarItemKind, IconName> = {
  event: "calendar",
  task: "tasks",
  note: "notes",
  project: "folder",
};

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Local calendar bounds for a 'YYYY-MM-DD' day as half-open ISO instants [from, to). Local
 *  midnight → UTC instant is exactly what `calendar.range` compares against. */
export function dayBounds(iso: string): { from: string; to: string } {
  const [y, m, d] = iso.split("-").map(Number);
  const from = new Date(y, m - 1, d);
  const to = new Date(y, m - 1, d + 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** 'HH:mm' local time for a timed item; used by the agenda and week grid. */
export function timeLabel(item: CalendarItem): string {
  if (isAllDay(item)) return "all day";
  const t = new Date(item.startsAt);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(t.getHours())}:${p(t.getMinutes())}`;
}

/** '2026-09-17' → '17 Sep', for the section eyebrow. */
function shortDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS_SHORT[m - 1]}`;
}

// The mono time column. 34px holds 'HH:mm'; 'all day' needs the wider one, and every row in
// a list takes the same width so the glyphs and titles stay on one edge.
const TIME_W = 34;
const TIME_W_ALL_DAY = 48;
const TIME_W_TOUCH = 56;

// A task given time from the agenda gets half an hour, in the grid's quarter-hour steps, from
// nine on a day that isn't today.
const BLOCK_MIN = 30;
const BLOCK_STEP = 15;
const BLOCK_START_HOUR = 9;
// The rows above the day grid scroll past this many, so a busy day can't squeeze the grid out.
const GRID_LIST_ROWS = 5.5;

const minutesOf = (iso: string) => {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
};
/** How long a timed item draws, in minutes: its own length, an hour for an event with no end,
 *  `POINT_MIN` for a task that is only a deadline or a start. */
const lengthOf = (it: CalendarItem) =>
  it.endsAt ? (new Date(it.endsAt).getTime() - new Date(it.startsAt).getTime()) / 60_000 : it.kind === "event" ? 60 : POINT_MIN;

/** The lengths an agenda item's Length menu offers, in minutes. */
const LENGTHS: [number, string][] = [
  [15, "15 minutes"],
  [30, "30 minutes"],
  [45, "45 minutes"],
  [60, "1 hour"],
  [90, "1½ hours"],
  [120, "2 hours"],
  [180, "3 hours"],
];

/** The time something new takes on `date`. Clicked into the grid at `from` minutes, it starts
 *  exactly there and runs half an hour, or up to whatever comes next (never under a quarter).
 *  Otherwise it is the next free half hour: from the coming quarter today, from nine any other day. */
function freeBlock(date: string, busy: { start: number; end: number }[], from?: number): { startsAt: string; endsAt: string } {
  let start: number;
  let len = BLOCK_MIN;
  if (from != null) {
    start = Math.min(from, DAY_MIN - BLOCK_STEP);
    const next = Math.min(DAY_MIN, ...busy.filter((b) => b.start > start).map((b) => b.start));
    len = Math.max(BLOCK_STEP, Math.min(BLOCK_MIN, next - start));
  } else {
    const now = new Date();
    const first = date === localDay(now) ? Math.ceil((now.getHours() * 60 + now.getMinutes()) / BLOCK_STEP) * BLOCK_STEP : BLOCK_START_HOUR * 60;
    start = Math.min(first, DAY_MIN - BLOCK_MIN);
    for (let m = start; m + BLOCK_MIN <= DAY_MIN; m += BLOCK_STEP) {
      if (!busy.some((b) => m < b.end && m + BLOCK_MIN > b.start)) {
        start = m;
        break;
      }
    }
  }
  const [y, mo, d] = date.split("-").map(Number);
  const startsAt = new Date(y, mo - 1, d, Math.floor(start / 60), start % 60);
  return { startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + len * 60_000).toISOString() };
}

/** Where "Add to agenda" puts a task on `date`: the next free half hour (as freeBlock hands out
 *  with no click), by the drop's rules — its start and deadline become the block, unless it's
 *  due after the day, when only its start moves there. The day's items come from `range`. */
export async function agendaPatch(
  task: Task,
  date: string,
  range: (from: string, to: string) => Promise<CalendarItem[]>,
): Promise<{ startAt: string; dueAt?: string }> {
  const { from, to } = dayBounds(date);
  const items = await range(from, to);
  const busy = items
    .filter((it) => !isAllDay(it) && !(it.kind === "task" && it.sourceId === task.id))
    .map((it) => ({ start: minutesOf(it.startsAt), end: minutesOf(it.startsAt) + lengthOf(it) }));
  const at = freeBlock(date, busy);
  const dueLater = !!task.dueAt && new Date(task.dueAt).getTime() >= new Date(to).getTime();
  return dueLater ? { startAt: at.startsAt } : { startAt: at.startsAt, dueAt: at.endsAt };
}

/** A single day's agenda: the merged items for `date` — events, tasks, dated notes. Used on the
 *  Today view (desktop aside + mobile panel) and mobile Calendar. Rows are pressable so a
 *  note/task can open; an event in a writable calendar opens its editor.
 *
 *  Time-blocking needs nothing of its own (PLAN-agenda.md): a task's block is its start → its
 *  deadline, an event's its start → end. What fits inside the day is a block of time; what
 *  doesn't is an all-day line. */
export function Agenda({
  date,
  onOpenItem,
  creatable = false,
  grid = false,
  visible = true,
}: {
  date: string;
  onOpenItem?: (item: CalendarItem) => void;
  /** Makes the agenda a place to plan the day (the Today view): a quick-add field for a task
   *  due on `date`, a palette (AgendaPalette) that finds an existing task or makes a new task or
   *  event at a time on it, and — once a writable calendar is connected — an "Add event" button. */
  creatable?: boolean;
  /** Lays the timed part of the day out as a quarter-hour grid that blocks are dragged and
   *  stretched in, under the all-day rows. It fills its parent and scrolls itself, so the host
   *  gives it a bounded height (the desktop Today aside). Without it everything is one list. */
  grid?: boolean;
  /** False while the host tab sits in the background; see AgendaGrid. */
  visible?: boolean;
}) {
  const { range, revision, writableFeeds, updateEvent } = useCalendar();
  const tasks = useTasks();
  const [items, setItems] = useState<CalendarItem[] | null>(null);
  const touch = useDensity() === "touch";
  // The event being edited or made, and the palette (with the quarter hour it was opened
  // from, when that was a click in the grid).
  const [editor, setEditor] = useState<EventEditorTarget | null>(null);
  const [picking, setPicking] = useState<{ from?: number } | null>(null);

  useEffect(() => {
    let alive = true;
    const { from, to } = dayBounds(date);
    void range(from, to).then((list) => {
      if (alive) setItems(list);
    });
    return () => {
      alive = false;
    };
  }, [date, range, revision]);

  const taskById = useMemo(() => new Map(tasks.tasks.map((t) => [t.id, t])), [tasks.tasks]);
  const taskOf = (it: CalendarItem) => (it.kind === "task" ? taskById.get(it.sourceId) : undefined);

  // All-day lines lead the day: anything that doesn't fit inside it still reads "all day".
  const allDay = (items ?? []).filter(isAllDay);
  const timed = (items ?? []).filter((it) => !isAllDay(it));
  const busy = timed.map((it) => ({ start: minutesOf(it.startsAt), end: minutesOf(it.startsAt) + lengthOf(it) }));

  const open = (item: CalendarItem) => {
    if (item.kind === "event" && item.editable) setEditor({ mode: "edit", item });
    else onOpenItem?.(item);
  };

  // The time the palette is handing out: the quarter clicked in the grid, else the next free
  // half hour.
  const block = picking ? freeBlock(date, busy, picking.from) : null;

  // An existing task put on the day takes a time. Its block is its start → deadline, so both
  // are set; unless it is due after this day, when only its start moves here, its deadline is
  // kept, and it reads all day until then. True when it became a block.
  const dueAfterDay = (task: Task) => !!task.dueAt && new Date(task.dueAt).getTime() >= new Date(dayBounds(date).to).getTime();
  const placeTask = (task: Task, at: { startsAt: string; endsAt: string }): boolean => {
    const dueLater = dueAfterDay(task);
    void tasks.update(task.id, dueLater ? { startAt: at.startsAt } : { startAt: at.startsAt, dueAt: at.endsAt });
    return !dueLater;
  };
  const addTask = (task: Task) => {
    if (!block) return;
    // A palette kept open (⇧⏎) hands the next pick the time after this one.
    if (placeTask(task, block)) setPicking({ from: minutesOf(block.endsAt) || DAY_MIN - BLOCK_STEP });
  };

  // A block dropped at a new time, or stretched. The block moves at once; the write follows,
  // and a refused one (the core says why) snaps back on the re-query.
  const moveBlock = (block: GridBlock, startsAt: string, endsAt: string) => {
    const item = timed.find((it) => it.id === block.id);
    if (item) moveItem(item, startsAt, endsAt);
  };
  const moveItem = (item: CalendarItem, startsAt: string, endsAt: string) => {
    const snapBack = () => setItems((prev) => (prev ? [...prev] : prev));
    if (item.kind === "event") {
      setItems((prev) => prev?.map((it) => (it.id === item.id ? { ...it, startsAt, endsAt } : it)) ?? prev);
      return void updateEvent(item.sourceId, { startsAt, endsAt, allDay: false }).catch(snapBack);
    }
    const task = taskOf(item);
    if (!task) return;
    const stretched = new Date(endsAt).getTime() - new Date(startsAt).getTime() !== lengthOf(item) * 60_000;
    const patch = taskBlockPatch(task, startsAt, endsAt, stretched);
    const moved = patch.startAt && patch.dueAt ? { startsAt, endsAt, span: true } : { startsAt };
    setItems((prev) => prev?.map((it) => (it.id === item.id ? { ...it, ...moved } : it)) ?? prev);
    void tasks.update(task.id, patch).catch(snapBack);
  };

  // A task dragged in from elsewhere (a link chip in a note or a chat, a chat preview, a canvas
  // card, a list row) and dropped on a quarter hour. One that is a block on the day already
  // moves there whole, as if dragged in the grid; any other takes the time a click on that
  // quarter hands out (freeBlock), by placeTask's rules. Only an open task takes time; notes
  // and canvases don't go on the agenda.
  const openTaskOf = (p: DragPayload) => {
    const task = p.kind === "task" ? tasks.byId(p.id) : undefined;
    return task?.status === "open" ? task : undefined;
  };
  const blockOf = (task: Task) => timed.find((it) => it.kind === "task" && it.sourceId === task.id);
  const drop: GridDrop = {
    accepts: (p) => !!openTaskOf(p),
    plan: (p, from) => {
      const task = openTaskOf(p);
      if (!task) return null;
      const onDay = blockOf(task);
      if (onDay) {
        const length = lengthOf(onDay);
        return { start: Math.max(0, Math.min(from, DAY_MIN - Math.ceil(length))), length };
      }
      const at = freeBlock(date, busy, from);
      const start = minutesOf(at.startsAt);
      if (task.dueAt && dueAfterDay(task)) {
        const due = new Date(task.dueAt).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }).toLowerCase();
        return { start, length: BLOCK_STEP, note: `starts ${clockLabel(start)} · due ${due}` };
      }
      return { start, length: (new Date(at.endsAt).getTime() - new Date(at.startsAt).getTime()) / 60_000 };
    },
    onDrop: (p, from) => {
      const task = openTaskOf(p);
      if (!task) return;
      const onDay = blockOf(task);
      if (!onDay) {
        placeTask(task, freeBlock(date, busy, from));
        return;
      }
      const length = lengthOf(onDay);
      const start = Math.max(0, Math.min(from, DAY_MIN - Math.ceil(length)));
      const [y, m, d] = date.split("-").map(Number);
      const startsAt = new Date(y, m - 1, d, Math.floor(start / 60), start % 60);
      moveItem(onDay, startsAt.toISOString(), new Date(startsAt.getTime() + length * 60_000).toISOString());
    },
  };

  // Right-click on an agenda item (a row, or a block in the grid). What's on the day can be
  // resized, pushed to tomorrow or taken off; a task can also be done or reopened, and it and a
  // dated note carry the item actions every list has (ItemMenus). An event only has actions when
  // its calendar is writable.
  const itemMenus = useItemMenus();
  const { removeEvent } = useCalendar();
  const [deleting, setDeleting] = useState<{ item: CalendarItem; scope?: "occurrence" | "series" } | null>(null);
  const DAY_MS = 24 * 60 * 60_000;
  const shift = (iso: string) => new Date(new Date(iso).getTime() + DAY_MS).toISOString();
  const menuFor = (it: CalendarItem): MenuEntry[] => {
    const timedItem = !isAllDay(it);
    const endOf = (from: string) => it.endsAt ?? new Date(new Date(from).getTime() + lengthOf(it) * 60_000).toISOString();
    const lengthMenu = (): MenuEntry => ({
      label: "Length",
      children: LENGTHS.map(([min, label]) => ({
        label,
        checked: Math.round(lengthOf(it)) === min,
        run: () => moveItem(it, it.startsAt, new Date(new Date(it.startsAt).getTime() + min * 60_000).toISOString()),
      })),
    });
    if (it.kind === "event") {
      if (!it.editable) return [];
      return [
        { label: "Edit Event…", run: () => setEditor({ mode: "edit", item: it }) },
        "separator",
        ...(timedItem && !it.recurring ? [lengthMenu()] : []),
        ...(!it.recurring
          ? [{ label: "Move to Tomorrow", run: () => void updateEvent(it.sourceId, { startsAt: shift(it.startsAt), endsAt: shift(endOf(it.startsAt)), allDay: it.allDay }) } as MenuEntry]
          : []),
        "separator",
        ...(it.recurring
          ? ([
              { label: "Delete This Occurrence…", run: () => setDeleting({ item: it, scope: "occurrence" }) },
              { label: "Delete All Occurrences…", run: () => setDeleting({ item: it, scope: "series" }) },
            ] as MenuEntry[])
          : [{ label: "Delete Event…", run: () => setDeleting({ item: it }) } as MenuEntry]),
      ];
    }
    const docEntries = itemMenus && (it.kind === "task" || it.kind === "note") ? itemMenus.docMenu({ kind: it.kind, id: it.sourceId }, { onAgenda: true }) : [];
    const opener: MenuEntry = { label: "Open", run: () => open(it) };
    if (it.kind !== "task") return [opener, "separator", ...docEntries];
    const task = taskOf(it);
    if (!task) return [opener];
    const isOpen = task.status === "open";
    return [
      opener,
      { label: isOpen ? "Mark as Done" : "Mark as Open", run: () => void tasks.setStatus(task.id, isOpen ? "done" : "open") },
      "separator",
      ...(timedItem && isOpen ? [lengthMenu()] : []),
      {
        label: "Move to Tomorrow",
        disabled: !isOpen,
        run: () =>
          timedItem
            ? moveItem(it, shift(it.startsAt), shift(endOf(it.startsAt)))
            : void tasks.update(task.id, { ...(task.startAt ? { startAt: shift(task.startAt) } : {}), ...(task.dueAt ? { dueAt: shift(task.dueAt) } : {}) }),
      },
      {
        // Its start (and a deadline on this day) are what put it here.
        label: "Remove from Agenda",
        disabled: !isOpen,
        run: () => void tasks.update(task.id, { clearStartAt: true, ...(dueAfterDay(task) ? {} : { clearDueAt: true }) }),
      },
      "separator",
      ...docEntries,
    ];
  };

  const blocks: GridBlock[] = grid
    ? timed.map((it) => {
        const task = taskOf(it);
        return {
          id: it.id,
          kind: it.kind,
          title: it.title,
          startsAt: it.startsAt,
          endsAt: it.endsAt ?? new Date(new Date(it.startsAt).getTime() + lengthOf(it) * 60_000).toISOString(),
          color: it.color,
          movable: it.kind === "event" ? !!it.editable && !it.recurring : creatable && task?.status === "open",
          pending: it.pending,
          done: !!task && task.status !== "open",
        };
      })
    : [];

  const listed = grid ? allDay : [...allDay, ...timed];
  const timeWidth = touch ? TIME_W_TOUCH : listed.some(isAllDay) ? TIME_W_ALL_DAY : TIME_W;
  const rows = (
    <View style={styles.rows}>
      {listed.map((it) => {
        const task = taskOf(it);
        // Tasks/notes open everywhere, and so does an event that can be edited. Any other event
        // opens to a detail subview on native, but on web isn't linkable (no local entity).
        const openable = it.kind === "event" ? !!it.editable || (!!onOpenItem && Platform.OS !== "web") : !!onOpenItem;
        return (
          <AgendaRow
            key={it.id}
            kind={it.kind}
            sourceId={it.sourceId}
            title={it.title}
            time={timeLabel(it)}
            color={it.color}
            done={!!task && task.status !== "open"}
            onPress={openable ? () => open(it) : undefined}
            menu={() => menuFor(it)}
            timeWidth={timeWidth}
            touch={touch}
          />
        );
      })}
    </View>
  );

  // Open tasks that aren't on the day already.
  const candidates = useMemo(() => {
    if (!picking) return [];
    const onDay = new Set((items ?? []).filter((it) => it.kind === "task").map((it) => it.sourceId));
    return tasks.tasks.filter((t) => t.status === "open" && !onDay.has(t.id));
  }, [picking, tasks.tasks, items]);

  return (
    <View style={grid ? styles.fill : null}>
      <View style={styles.headerRow}>
        <Text variant="eyebrow" tone="quaternary" style={styles.headerLabel}>
          Agenda · {shortDate(date)}
        </Text>
        {creatable && writableFeeds.length > 0 ? <AgendaAddEvent date={date} /> : null}
      </View>
      {creatable ? <AgendaTaskInput date={date} onFind={() => setPicking({})} touch={touch} /> : null}
      {grid ? (
        <>
          {listed.length > 0 ? <ScrollView style={[styles.gridList, { maxHeight: GRID_LIST_ROWS * (row.h + 1) }]}>{rows}</ScrollView> : null}
          <View style={styles.gridFrame}>
            <AgendaGrid
              date={date}
              blocks={blocks}
              visible={visible}
              onPressBlock={(block) => {
                const item = timed.find((it) => it.id === block.id);
                if (item) open(item);
              }}
              blockMenu={(block) => {
                const item = timed.find((it) => it.id === block.id);
                return item ? menuFor(item) : [];
              }}
              onMove={moveBlock}
              dragPayload={(block) => {
                const item = timed.find((it) => it.id === block.id);
                return item ? refPayload(item.kind, item.sourceId, item.title) : null;
              }}
              onPressSlot={creatable ? (from) => setPicking({ from }) : undefined}
              drop={creatable ? drop : undefined}
            />
          </View>
        </>
      ) : items && listed.length === 0 ? (
        <Text variant="caption" tone="tertiary" style={styles.empty}>
          Clear day. Enjoy the whitespace.
        </Text>
      ) : (
        rows
      )}
      {editor ? <EventEditorDialog target={editor} onClose={() => setEditor(null)} /> : null}
      {deleting ? (
        <ConfirmDialog
          portal
          title={deleting.scope === "series" ? "Delete every occurrence?" : "Delete event?"}
          message={
            deleting.scope === "series"
              ? `Every occurrence of “${deleting.item.title}” is removed from its calendar.`
              : `“${deleting.item.title}” is removed from its calendar.`
          }
          onConfirm={async () => {
            await removeEvent(deleting.item.sourceId, deleting.scope);
            setDeleting(null);
          }}
          onClose={() => setDeleting(null)}
        />
      ) : null}
      {picking && block ? (
        <AgendaPalette
          block={block}
          candidates={candidates}
          canAddEvent={writableFeeds.length > 0}
          onPickTask={addTask}
          onNewTask={(title) => void tasks.create({ title, startAt: block.startsAt, dueAt: block.endsAt })}
          onNewEvent={(title) => setEditor({ mode: "create", startsAt: new Date(block.startsAt), endsAt: new Date(block.endsAt), title })}
          onClose={() => setPicking(null)}
        />
      ) : null}
    </View>
  );
}

// A task added from the agenda is due at the end of the working day, like the task editor's
// "Today" deadline preset — a deadline is what puts a task on the calendar. A new event starts
// at the next full hour when the day is today, else at nine.
const TASK_DUE_HOUR = 17;
const EVENT_START_HOUR = 9;

/** Quick-add for the day, like the input over the task list: type a title, press Enter, and the
 *  task lands in the agenda, due on `date`. Focus stays in the field, so a run of tasks can be
 *  typed one after another. The button beside it looks up a task that already exists instead. */
function AgendaTaskInput({ date, onFind, touch }: { date: string; onFind: () => void; touch: boolean }) {
  const tasks = useTasks();
  const [draft, setDraft] = useState("");
  const add = () => {
    const title = draft.trim();
    if (!title) return;
    setDraft("");
    const [y, m, d] = date.split("-").map(Number);
    void tasks.create({ title, dueAt: new Date(y, m - 1, d, TASK_DUE_HOUR).toISOString() });
  };
  return (
    <View style={styles.quickAdd}>
      <View style={styles.quickAddField}>
        <Input
          size="sm"
          placeholder="Add a task, press Enter"
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={add}
          keepFocusOnSubmit
          leadingIcon={<Icon name="plus" size={icon.sm} color={colors.textQuaternary} />}
        />
      </View>
      {/* The other way to add to the day: the palette, to look up a task that already exists. */}
      <IconButton label="Find a task to add" size={touch ? undefined : "sm"} onPress={onFind}>
        <Icon name="search" size={touch ? icon.md : icon.sm} color={colors.textTertiary} />
      </IconButton>
    </View>
  );
}

/** "Add event", in the agenda's header once a writable calendar is connected: opens the event
 *  editor on `date`. */
function AgendaAddEvent({ date }: { date: string }) {
  const [editor, setEditor] = useState<EventEditorTarget | null>(null);
  const open = () => {
    const [y, m, d] = date.split("-").map(Number);
    const now = new Date();
    const hour = date === localDay(now) ? Math.min(now.getHours() + 1, 23) : EVENT_START_HOUR;
    setEditor({ mode: "create", startsAt: new Date(y, m - 1, d, hour) });
  };
  return (
    <>
      <Button variant="ghost" size="sm" label="Add event" onPress={open} icon={<Icon name="plus" size={icon.sm} color={colors.textTertiary} />} />
      {editor ? <EventEditorDialog target={editor} onClose={() => setEditor(null)} /> : null}
    </>
  );
}

/** Local 'YYYY-MM-DD' of a date. */
function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 'Today', 'Tomorrow', else 'Sat 20 Sep' — the day headings of the upcoming agenda. */
function dayHeading(iso: string, today: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const [ty, tm, td] = today.split("-").map(Number);
  const diff = Math.round((date.getTime() - new Date(ty, tm - 1, td).getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return `${DAYS_SHORT[date.getDay()]} ${d} ${MONTHS_SHORT[m - 1]}`;
}

// How far the upcoming agenda looks, and how much each "show more" adds. It stops at a year:
// that is as far as calendars are expanded.
const UPCOMING_DAYS = 14;
const UPCOMING_MAX_DAYS = 365;

/** What's coming up, day by day, from today through the next two weeks (more on request) — the
 *  project's calendar when `projectId` is given. Where one day's agenda is too narrow a window:
 *  a project's Calendar tab on a phone, where the question is "what's next for this?". Rows are
 *  the day agenda's. Something that began before today and runs into it is listed under today. */
export function UpcomingAgenda({
  projectId,
  onOpenItem,
}: {
  projectId?: string;
  onOpenItem?: (item: CalendarItem) => void;
}) {
  const { range, revision } = useCalendar();
  const [days, setDays] = useState(UPCOMING_DAYS);
  const [items, setItems] = useState<CalendarItem[] | null>(null);
  const touch = useDensity() === "touch";
  // Part of the query's key, so an agenda left open past midnight moves on with the next refresh.
  const today = localDay(new Date());

  useEffect(() => {
    let alive = true;
    const [y, m, d] = today.split("-").map(Number);
    const from = new Date(y, m - 1, d);
    const to = new Date(y, m - 1, d + days);
    void range(from.toISOString(), to.toISOString(), projectId ? { projectId } : undefined).then((list) => {
      if (alive) setItems(list);
    });
    return () => {
      alive = false;
    };
  }, [range, revision, projectId, days, today]);

  const groups = useMemo(() => {
    const byDay = new Map<string, CalendarItem[]>();
    for (const it of items ?? []) {
      const day = itemDay(it) < today ? today : itemDay(it);
      const list = byDay.get(day);
      if (list) list.push(it);
      else byDay.set(day, [it]);
    }
    return [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }, [items, today]);

  const timeWidth = touch ? TIME_W_TOUCH : (items ?? []).some(isAllDay) ? TIME_W_ALL_DAY : TIME_W;

  return (
    <View>
      <Text variant="eyebrow" tone="quaternary" style={styles.header}>
        Upcoming
      </Text>
      {items && groups.length === 0 ? (
        <Text variant="caption" tone="tertiary" style={styles.empty}>
          Nothing scheduled in the next {days === UPCOMING_DAYS ? "two weeks" : `${days} days`}.
        </Text>
      ) : (
        groups.map(([day, list]) => (
          <View key={day}>
            <Text variant="mono" tone="tertiary" style={styles.dayHeading}>
              {dayHeading(day, today)}
            </Text>
            <View style={styles.rows}>
              {list.map((it) => (
                <AgendaRow
                  key={it.id}
                  kind={it.kind}
                  sourceId={it.sourceId}
                  title={it.title}
                  time={timeLabel(it)}
                  color={it.color}
                  // Tasks/notes open everywhere; feed events open to a detail subview on native,
                  // but on web they aren't linkable (no local entity).
                  onPress={onOpenItem && (it.kind !== "event" || Platform.OS !== "web") ? () => onOpenItem(it) : undefined}
                  timeWidth={timeWidth}
                  touch={touch}
                />
              ))}
            </View>
          </View>
        ))
      )}
      {items && days < UPCOMING_MAX_DAYS ? (
        <View style={styles.more}>
          <Button
            variant="ghost"
            size="sm"
            label="Show two more weeks"
            onPress={() => setDays((n) => Math.min(UPCOMING_MAX_DAYS, n + UPCOMING_DAYS))}
          />
        </View>
      ) : null}
    </View>
  );
}

/** One agenda line: time · kind · title. With a pointer, hovering highlights the row. Pressing opens the item when the host gave it somewhere to go. Pointer rows are
 *  24px; touch rows 44px. A task, note or project drags (web/desktop) onto the daily note as
 *  a chip, onto a project or an area to file it. */
function AgendaRow({
  kind,
  sourceId,
  title,
  time,
  color,
  done = false,
  onPress,
  menu,
  timeWidth,
  touch,
}: {
  kind: CalendarItemKind;
  /** The backing row's id, which a drag carries. */
  sourceId: string;
  title: string;
  /** The mono time column: 'HH:mm' or 'all day'. */
  time: string;
  /** A feed's own swatch, for events. */
  color?: string | null;
  /** A finished task: struck through. */
  done?: boolean;
  onPress?: () => void;
  /** The row's right-click menu (see contextMenu.ts). */
  menu?: () => MenuEntry[];
  timeWidth: number;
  touch: boolean;
}) {
  const gap = touch ? space.ml : space.md;
  const drag = useRefDrag(kind, sourceId, title);
  return (
    <View {...drag} style={drag ? noSelect : null}>
      <Pressable
        {...contextMenuProps(menu ?? null)}
        disabled={!onPress}
        onPress={onPress}
        style={({ hovered, pressed }: PressState) => [
          styles.row,
          transition("background-color", motion.instant),
          {
            minHeight: touch ? row.touch : row.h,
            backgroundColor: pressed && onPress ? colors.surfaceActive : hovered ? colors.surfaceHover : "transparent",
          },
        ]}
      >
        <View style={[styles.rowMain, { gap }]}>
          <Text variant="mono" tone="quaternary" style={{ width: timeWidth, flexShrink: 0 }} numberOfLines={1}>
            {time}
          </Text>
          {touch ? (
            <View style={[styles.dot, { backgroundColor: color ?? KIND_COLOR[kind] }]} />
          ) : (
            <Icon name={KIND_ICON[kind]} size={icon.sm} color={color ?? colors.textQuaternary} />
          )}
          <Text variant="label" tone={done ? "tertiary" : undefined} style={[styles.title, done ? styles.struck : null]} numberOfLines={1}>
            {title || "Untitled"}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

const styles = {
  header: { paddingHorizontal: space.sm, paddingTop: space.md, paddingBottom: 3 },
  // The day agenda's header: the same eyebrow, with room for the plus on its right.
  headerRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    paddingHorizontal: space.sm,
    paddingTop: space.md,
    paddingBottom: 3,
    // Holds its height whether or not the "Add event" button is there.
    minHeight: control.sm + space.md + 3,
  },
  headerLabel: { flex: 1 },
  quickAdd: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingTop: space.xs,
    paddingBottom: space.sm,
  },
  quickAddField: { flex: 1, minWidth: 0 },
  // Grid mode: the agenda fills what its host gives it; the all-day rows keep to a few lines
  // and the day grid takes the rest, scrolling on its own.
  fill: { flex: 1, minHeight: 0 },
  gridList: { flexGrow: 0, flexShrink: 0, marginBottom: space.xs },
  gridFrame: { flex: 1, minHeight: 0, borderTopWidth: 1, borderTopColor: colors.borderSubtle },
  empty: { paddingHorizontal: space.sm, paddingVertical: space.md },
  dayHeading: { paddingHorizontal: space.sm, paddingTop: space.md, paddingBottom: 3 },
  more: { flexDirection: "row" as const, paddingTop: space.md },
  rows: { gap: 1 },
  row: {
    justifyContent: "center" as const,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
  },
  struck: { textDecorationLine: "line-through" as const },
  rowMain: { flexDirection: "row" as const, alignItems: "center" as const },
  dot: { width: 7, height: 7, flexShrink: 0, borderRadius: radius.full },
  title: { flex: 1, minWidth: 0 },
};
