import { useEffect, useMemo, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import type { CalendarItem, CalendarItemKind } from "@companion/core-bridge";
import {
  Button,
  Icon,
  Input,
  Text,
  colors,
  control,
  icon,
  motion,
  radius,
  row,
  space,
  transition,
  useDensity,
  type IconName,
  type PressState,
} from "@companion/design-system";
import { useCalendar } from "./CalendarProvider";
import { EventEditorDialog, type EventEditorTarget } from "./EventEditorDialog";
import { useTasks } from "./TasksProvider";

/** The local calendar day ('YYYY-MM-DD') an item falls on. All-day items (dated notes,
 *  all-day events) carry a date-only marker stored as midnight UTC; converting that instant
 *  to local time would shift it a day in some zones, so their date portion is used directly.
 *  Timed items use their instant in the user's timezone. */
export function itemDay(item: CalendarItem): string {
  if (item.allDay) return item.startsAt.slice(0, 10);
  return localDay(new Date(item.startsAt));
}

/** Whether an item belongs in a day's all-day band: an all-day event or dated note, or a span
 *  — a task or project running from its start to its deadline (PLAN-scheduling.md §4). */
export function isAllDay(item: CalendarItem): boolean {
  return item.allDay || !!item.span;
}

/** Every local day ('YYYY-MM-DD') a span covers, first to last: from the day it starts to the
 *  day of its deadline, in the viewer's timezone. Any other item covers just its `itemDay`. */
export function itemDays(item: CalendarItem): string[] {
  if (!item.span || !item.endsAt) return [itemDay(item)];
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

/** A single day's agenda: the merged items for `date`, one line each (time · kind · title).
 *  Used on the Today view (desktop aside + mobile panel) and mobile Calendar. Rows are
 *  pressable so a note/task can open; feed events aren't openable. */
export function Agenda({
  date,
  onOpenItem,
  creatable = false,
}: {
  date: string;
  onOpenItem?: (item: CalendarItem) => void;
  /** Makes the agenda a place to add to the day (the Today view): a quick-add field for a task
   *  due on `date`, and — once a writable calendar is connected — an "Add event" button. */
  creatable?: boolean;
}) {
  const { range, revision, writableFeeds } = useCalendar();
  const [items, setItems] = useState<CalendarItem[] | null>(null);
  const touch = useDensity() === "touch";

  useEffect(() => {
    let alive = true;
    const { from, to } = dayBounds(date);
    void range(from, to).then((list) => {
      // All-day lines lead the day: a span that starts mid-morning still reads "all day".
      if (alive) setItems([...list.filter(isAllDay), ...list.filter((it) => !isAllDay(it))]);
    });
    return () => {
      alive = false;
    };
  }, [date, range, revision]);

  const timeWidth = touch ? TIME_W_TOUCH : (items ?? []).some(isAllDay) ? TIME_W_ALL_DAY : TIME_W;

  return (
    <View>
      <View style={styles.headerRow}>
        <Text variant="eyebrow" tone="quaternary" style={styles.headerLabel}>
          Agenda · {shortDate(date)}
        </Text>
        {creatable && writableFeeds.length > 0 ? <AgendaAddEvent date={date} /> : null}
      </View>
      {creatable ? <AgendaTaskInput date={date} /> : null}
      {items && items.length === 0 ? (
        <Text variant="caption" tone="tertiary" style={styles.empty}>
          Clear day. Enjoy the whitespace.
        </Text>
      ) : (
        <View style={styles.rows}>
          {(items ?? []).map((it) => (
            <AgendaRow key={it.id} item={it} onOpenItem={onOpenItem} timeWidth={timeWidth} touch={touch} />
          ))}
        </View>
      )}
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
 *  typed one after another. */
function AgendaTaskInput({ date }: { date: string }) {
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
                <AgendaRow key={it.id} item={it} onOpenItem={onOpenItem} timeWidth={timeWidth} touch={touch} />
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

/** One agenda line: time · kind · title. With a pointer, hovering highlights the row. Tapping
 *  opens the item when the host wired `onOpenItem`. Pointer rows are 24px; touch rows 44px. */
function AgendaRow({
  item,
  onOpenItem,
  timeWidth,
  touch,
}: {
  item: CalendarItem;
  onOpenItem?: (item: CalendarItem) => void;
  timeWidth: number;
  touch: boolean;
}) {
  // Tasks/notes open everywhere. Feed events open to a detail subview on native, but on web
  // they aren't linkable (no local entity).
  const openable = !!onOpenItem && (item.kind !== "event" || Platform.OS !== "web");
  const gap = touch ? space.ml : space.md;
  return (
    <Pressable
      disabled={!openable}
      onPress={() => onOpenItem?.(item)}
      style={({ hovered, pressed }: PressState) => [
        styles.row,
        transition("background-color", motion.instant),
        {
          minHeight: touch ? row.touch : row.h,
          backgroundColor: pressed && openable ? colors.surfaceActive : hovered ? colors.surfaceHover : "transparent",
        },
      ]}
    >
      <View style={[styles.rowMain, { gap }]}>
        <Text variant="mono" tone="quaternary" style={{ width: timeWidth, flexShrink: 0 }} numberOfLines={1}>
          {timeLabel(item)}
        </Text>
        {touch ? (
          <View style={[styles.dot, { backgroundColor: item.color ?? KIND_COLOR[item.kind] }]} />
        ) : (
          <Icon name={KIND_ICON[item.kind]} size={icon.sm} color={item.color ?? colors.textQuaternary} />
        )}
        <Text variant="label" style={styles.title} numberOfLines={1}>
          {item.title || "Untitled"}
        </Text>
      </View>
    </Pressable>
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
  quickAdd: { paddingHorizontal: space.sm, paddingTop: space.xs, paddingBottom: space.sm },
  empty: { paddingHorizontal: space.sm, paddingVertical: space.md },
  dayHeading: { paddingHorizontal: space.sm, paddingTop: space.md, paddingBottom: 3 },
  more: { flexDirection: "row" as const, paddingTop: space.md },
  rows: { gap: 1 },
  row: {
    justifyContent: "center" as const,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
  },
  rowMain: { flexDirection: "row" as const, alignItems: "center" as const },
  dot: { width: 7, height: 7, flexShrink: 0, borderRadius: radius.full },
  title: { flex: 1, minWidth: 0 },
};
