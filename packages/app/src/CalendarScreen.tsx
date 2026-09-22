import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanResponder, Pressable, ScrollView, View, type PanResponderGestureState } from "react-native";
import type { CalendarItem } from "@companion/core-bridge";
import {
  Button,
  Divider,
  Icon,
  IconButton,
  Spinner,
  Text,
  colors,
  control,
  font,
  motion,
  radius,
  shadow,
  space,
  transition,
  type PressState,
} from "@companion/design-system";
import { useCalendar } from "./CalendarProvider";
import { isAllDay, itemDay, itemDays } from "./CalendarAgenda";
import { CalendarItemInfo } from "./CalendarItemInfo";
import { DAY_MIN, KIND, layoutLanes, spanOf, taskBlockPatch, type Lane } from "./calendarLayout";
import { EventEditorDialog, type EventEditorTarget } from "./EventEditorDialog";
import { useProjectCalendars } from "./ProjectCalendars";
import { useTasks } from "./TasksProvider";
import { useNav } from "./nav-context";
import { TourAnchor } from "./onboarding/anchors";

// The Calendar tool (PLAN §6.7): a week grid of merged events, due tasks, and dated notes,
// mirroring the prototype's CalendarView. Habit streaks join it when habits (§16) land. The
// same grid is a project's calendar (PLAN §6.6) when given the project's id.

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Dense grid geometry: a 34px hour row, a 40px hour gutter and a 32px toolbar.
const ROW_H = 34;
const GUTTER = 40;
const TOOLBAR_H = 32;
// The all-day band shows this many chips per day before collapsing the rest into "+N more".
const ALL_DAY_MAX = 2;
// The hover detail card.
const CARD_W = 220;
// The grid spans the whole day; it scrolls to reveal any hour (00:00–24:00).
const HOURS = Array.from({ length: 24 }, (_, h) => h);
// Where the grid scrolls to on open when the week has no earlier event (~7am).
const DEFAULT_SCROLL_HOUR = 7;

/** '12a', '9a', '12p', '3p' for an hour 0–23. */
function hourLabel(h: number): string {
  if (h === 0) return "12a";
  if (h < 12) return `${h}a`;
  if (h === 12) return "12p";
  return `${h - 12}p`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** Local midnight of the Sunday that starts d's week. */
function weekStartOf(d: Date): Date {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  s.setDate(s.getDate() - s.getDay());
  return s;
}
/** ISO-8601 week number of the week containing `d` (weeks start Monday; week 1 holds the
 *  year's first Thursday). */
function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); // that week's Thursday
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

/** The week grid. With `projectId` it is that project's calendar: the events of the calendars it
 *  holds and its own tasks and notes, and a new event goes in one of its calendars. */
export function CalendarScreen({ projectId }: { projectId?: string } = {}) {
  const { range, revision, refresh, getViewState: viewStateOf, setViewState: saveViewState, writableFeeds, updateEvent, conflicts, dismissConflicts } =
    useCalendar();
  // Each project's grid remembers its own week and scroll; the Calendar tool keeps the default.
  const viewKey = projectId ? `project:${projectId}` : "";
  const getViewState = useCallback(() => viewStateOf(viewKey), [viewStateOf, viewKey]);
  const setViewState = useCallback(
    (patch: Parameters<typeof saveViewState>[0]) => saveViewState(patch, viewKey),
    [saveViewState, viewKey],
  );
  const project = useProjectCalendars(projectId);
  // Where a new event can go: in a project, only the project's own writable calendars — an event
  // put anywhere else would not show on the grid it was created from.
  const creatable = projectId ? project.writableFeeds : writableFeeds;
  // The event being created or edited (PLAN-caldav.md §6); null when the dialog is closed.
  const [editor, setEditor] = useState<EventEditorTarget | null>(null);
  const tasks = useTasks();
  const nav = useNav();
  // Tasks open in a new workspace tab. A dated note is a daily note, so it opens the Today
  // tool on that day rather than the notes browse list. An event in a CalDAV calendar opens
  // the editor; subscription events are read-only and only surface their hover card.
  const openItem = (item: CalendarItem) => {
    if (item.kind === "task") nav.openInNewTab({ kind: "task", id: item.sourceId });
    else if (item.kind === "project") nav.openProject(item.sourceId);
    else if (item.kind === "note") nav.openInNewTab({ kind: "view", view: "today", date: itemDay(item) });
    else if (item.editable) setEditor({ mode: "edit", item });
  };
  // "New event" starts at the next full hour — today if this week is showing, else on the
  // first day of the visible week.
  const newEvent = () => {
    const today = new Date();
    const inWeek = weekDays.some((d) => toISODate(d) === toISODate(today));
    const day = inWeek ? today : weekDays[0];
    const hour = inWeek ? Math.min(23, today.getHours() + 1) : 9;
    setEditor({ mode: "create", startsAt: new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, 0) });
  };
  // Restore the last visible week (persisted on the provider so it survives navigating away).
  const [anchor, setAnchor] = useState(() => {
    const saved = getViewState().anchorMs;
    return saved != null ? new Date(saved) : new Date();
  });
  // A day asked for by the tab itself (/calendar/2026-07-08 — the command palette opening an
  // event) wins over the remembered week. Not inside a project, whose location is its own.
  const askedDay = !projectId && nav.current.kind === "view" && nav.current.view === "calendar" ? nav.current.date : undefined;
  useEffect(() => {
    if (!askedDay) return;
    const [y, m, d] = askedDay.split("-").map(Number);
    if (y && m && d) setAnchor(new Date(y, m - 1, d));
  }, [askedDay]);
  const [items, setItems] = useState<CalendarItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  // The all-day band holds two chips per day; "+N more" opens it up for the visible week.
  const [expandAllDay, setExpandAllDay] = useState(false);
  // A day column's pixel width, measured via a ref (this RN typing has no onLayout on View,
  // so measure like useDropTarget does) — drag-to-reschedule maps horizontal drag distance to
  // a number of days.
  const [colWidth, setColWidth] = useState(0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const colRef = useRef<any>(null);
  const [scrollbarW, setScrollbarW] = useState(0);
  // The ScrollView ref type differs between the RN and RN-web typings, so keep it loose;
  // scrollTo exists on both at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scrollRef = useRef<any>(null);
  // Which day column is hovered (or being dragged from). react-native-web gives every View
  // `position: relative; z-index: 0`, so each column is its own stacking context: a hover card
  // that spills into the next column can never paint over it from the inside, however high its
  // own zIndex. Lifting the whole column while it's hovered is what actually raises the card.
  const [hoverDay, setHoverDay] = useState<number | null>(null);
  const setDayHovered = useCallback(
    (day: number, on: boolean) => setHoverDay((prev) => (on ? day : prev === day ? null : prev)),
    [],
  );

  const onRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  };

  // Persist the visible week whenever it changes, so returning to the calendar lands here.
  useEffect(() => {
    setViewState({ anchorMs: anchor.getTime() });
  }, [anchor, setViewState]);

  const weekStart = useMemo(() => weekStartOf(anchor), [anchor]);
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + i)),
    [weekStart],
  );
  useEffect(() => setExpandAllDay(false), [weekStart]);

  // Drag-to-reschedule a task: translate the drop's day/time delta into a new due instant,
  // snap to 15 minutes, update the task (optimistically move the block so it doesn't jump),
  // and let the follow-up sync re-query reconcile it (PLAN §6.4/§6.7). Tasks are draggable,
  // and so are one-off events in a CalDAV calendar; subscription events are read-only, a
  // repeating event can't be moved from here yet, and notes are date-only markers.
  const reschedule = useCallback(
    (item: CalendarItem, dayIndex: number, dx: number, dy: number) => {
      if (!colWidth) return;
      const orig = new Date(item.startsAt);
      const durationMs = item.endsAt ? new Date(item.endsAt).getTime() - orig.getTime() : 0;
      const newDayIndex = Math.min(6, Math.max(0, dayIndex + Math.round(dx / colWidth)));
      const startMin = orig.getHours() * 60 + orig.getMinutes();
      let newMin = Math.round((startMin + (dy / ROW_H) * 60) / 15) * 15;
      newMin = Math.min(24 * 60 - 15, Math.max(0, newMin));
      const base = weekDays[newDayIndex];
      const newStart = new Date(base.getFullYear(), base.getMonth(), base.getDate(), Math.floor(newMin / 60), newMin % 60);
      const iso = newStart.toISOString();
      if (iso === item.startsAt) return; // dropped where it started
      setItems((prev) =>
        prev.map((it) =>
          it.id === item.id
            ? { ...it, startsAt: iso, endsAt: durationMs ? new Date(newStart.getTime() + durationMs).toISOString() : it.endsAt }
            : it,
        ),
      );
      if (item.kind === "event") {
        const endsAt = new Date(newStart.getTime() + (durationMs || 60 * 60_000)).toISOString();
        // A refused move (the core says why) snaps back on the re-query.
        void updateEvent(item.sourceId, { startsAt: iso, endsAt, allDay: false }).catch(() => setItems((prev) => [...prev]));
        return;
      }
      // A task's block is its start → deadline: one that has both moves whole, a point moves
      // the one date it has (PLAN-agenda.md).
      const task = tasks.tasks.find((t) => t.id === item.sourceId);
      const endIso = new Date(newStart.getTime() + durationMs).toISOString();
      void tasks.update(item.sourceId, task ? taskBlockPatch(task, iso, endIso, false) : { dueAt: iso });
    },
    [colWidth, weekDays, tasks, updateEvent],
  );

  // Drag an event's bottom edge to change when it ends (15-minute steps, at least 15 minutes,
  // never past midnight — the grid is one day tall). Same optimistic pattern as reschedule.
  // One-off events in a writable calendar only: on a repeating event this would silently
  // lengthen every occurrence, which belongs in the editor where that is spelled out.
  const resize = useCallback(
    (item: CalendarItem, dy: number) => {
      const start = new Date(item.startsAt);
      const startMin = start.getHours() * 60 + start.getMinutes();
      const curEnd = item.endsAt ? new Date(item.endsAt) : new Date(start.getTime() + 60 * 60_000);
      const curLen = Math.round((curEnd.getTime() - start.getTime()) / 60_000);
      let len = Math.round((curLen + (dy / ROW_H) * 60) / 15) * 15;
      len = Math.min(DAY_MIN - startMin, Math.max(15, len));
      if (len === curLen) return;
      const endsAt = new Date(start.getTime() + len * 60_000).toISOString();
      setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, endsAt } : it)));
      void updateEvent(item.sourceId, { endsAt }).catch(() => setItems((prev) => [...prev]));
    },
    [updateEvent],
  );

  // Measure the day-column width for drag math, and re-measure when the week changes or the
  // window resizes (web). A tick after render so layout has settled.
  useEffect(() => {
    const measure = () => {
      const node = colRef.current;
      if (node && typeof node.measureInWindow === "function") {
        node.measureInWindow((_x: number, _y: number, w: number) => {
          if (w > 0) setColWidth(w);
        });
      }
      // A classic (non-overlay) scrollbar narrows the hour grid but not the header rows above
      // it; pad those by the same amount so the seven columns stay on one set of rules.
      const scroller = scrollRef.current?.getScrollableNode?.();
      if (scroller && typeof scroller.offsetWidth === "number" && scroller.offsetWidth > 0) {
        setScrollbarW(Math.max(0, scroller.offsetWidth - scroller.clientWidth));
      }
    };
    const id = setTimeout(measure, 0);
    // The resize listener is window-wide, so only the visible tab holds it; a tab coming back
    // to the front re-measures (a hidden one can report a zero width).
    if (nav.visible && typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("resize", measure);
      return () => {
        clearTimeout(id);
        window.removeEventListener("resize", measure);
      };
    }
    return () => clearTimeout(id);
  }, [weekStart, nav.visible]);

  // A ticking clock so the "now" line tracks real time (updated each minute). Only the
  // visible tab keeps it; a background tab catches up the moment it's shown.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!nav.visible) return;
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, [nav.visible]);
  const nowY = ((now.getHours() * 60 + now.getMinutes()) / 60) * ROW_H;
  const todayISO = toISODate(now);

  useEffect(() => {
    let alive = true;
    const from = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate());
    const to = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7);
    void range(from.toISOString(), to.toISOString(), projectId ? { projectId } : undefined).then((list) => {
      if (alive) setItems(list);
    });
    return () => {
      alive = false;
    };
  }, [weekStart, range, revision, projectId]);

  // Bucket items per weekday ISO, split into all-day (note markers, all-day events) and
  // timed. The grid always spans the full day (00:00–24:00) and scrolls.
  const byDay = useMemo(() => {
    const map = new Map<string, { allDay: CalendarItem[]; timed: CalendarItem[] }>();
    for (const d of weekDays) map.set(toISODate(d), { allDay: [], timed: [] });
    for (const it of items) {
      // All-day items (dated notes, all-day events) carry a date-only marker stored as
      // midnight UTC; converting that instant to local time would shift it a day in some
      // zones, so bucket them by the date portion directly. Timed items use their instant.
      // A span — a task or project running from its start to its deadline — sits in the
      // all-day band of every day it covers (PLAN-scheduling.md §4).
      for (const iso of itemDays(it)) {
        const bucket = map.get(iso);
        if (!bucket) continue;
        (isAllDay(it) ? bucket.allDay : bucket.timed).push(it);
      }
    }
    return map;
  }, [items, weekDays]);

  // Lanes per day, so concurrent blocks split their column instead of stacking.
  const lanesByDay = useMemo(() => {
    const map = new Map<string, Map<string, Lane>>();
    for (const [iso, bucket] of byDay) map.set(iso, layoutLanes(bucket.timed));
    return map;
  }, [byDay]);

  const hasAllDay = useMemo(() => weekDays.some((d) => (byDay.get(toISODate(d))?.allDay.length ?? 0) > 0), [byDay, weekDays]);
  const monthLabel = `${MONTHS[weekStart.getMonth()]} ${weekStart.getFullYear()}`;

  const stepWeek = (delta: number) =>
    setAnchor((a) => new Date(a.getFullYear(), a.getMonth(), a.getDate() + delta * 7));

  // On first open, restore the persisted scroll offset; if there is none, scroll the
  // current-time line into view (or the morning if today isn't in the visible week) so the
  // full 24h grid never strands the user at midnight. Runs once, the first time the tab is
  // actually on screen — switching weeks keeps the user's scroll position rather than jumping.
  const didScroll = useRef(false);
  useEffect(() => {
    if (!nav.visible || didScroll.current) return;
    const saved = getViewState().scrollY;
    let y = saved;
    if (!(saved > 0)) {
      const d = new Date();
      const inWeek = weekDays.some((wd) => toISODate(wd) === toISODate(d));
      const target = inWeek ? (d.getHours() * 60 + d.getMinutes()) / 60 * ROW_H : DEFAULT_SCROLL_HOUR * ROW_H;
      y = Math.max(0, target - 3 * ROW_H);
    }
    // Run a tick after layout so content is measured.
    const id = setTimeout(() => {
      didScroll.current = true;
      scrollRef.current?.scrollTo({ y, animated: false });
    }, 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav.visible]);

  // onScroll / scrollEventThrottle aren't in this stripped RN ScrollView typing, but RNW
  // supports them at runtime; pass them through a loosely-typed spread. Persist the offset so
  // returning to the calendar restores the scroll.
  const scrollProps = {
    scrollEventThrottle: 64,
    onScroll: (e: { nativeEvent: { contentOffset: { y: number } } }) => setViewState({ scrollY: e.nativeEvent.contentOffset.y }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return (
    // The whole week is what the calendar tour points at.
    <TourAnchor id="calendar.week" style={styles.root}>
      {/* Toolbar: month, week nav, ISO week, legend, refresh, jump-to-today */}
      <View style={styles.toolbar}>
        <Icon name="calendar" size={14} color={colors.textSecondary} />
        <Text variant="title" numberOfLines={1}>
          {monthLabel}
        </Text>
        <View style={styles.navGroup}>
          <IconButton label="Previous week" size="sm" onPress={() => stepWeek(-1)}>
            <Icon name="chevronLeft" size={14} color={colors.textSecondary} />
          </IconButton>
          <IconButton label="Next week" size="sm" onPress={() => stepWeek(1)}>
            <Icon name="chevronRight" size={14} color={colors.textSecondary} />
          </IconButton>
        </View>
        <Text variant="mono" tone="quaternary">
          w{pad(isoWeek(weekDays[4]))}
        </Text>
        <Divider vertical style={styles.toolbarDivider} />
        <Legend />
        <View style={{ flex: 1 }} />
        {refreshing ? (
          <View style={styles.refreshSlot}>
            <Spinner inline size={12} />
          </View>
        ) : (
          <IconButton label="Refresh calendars" size="sm" onPress={onRefresh}>
            <Icon name="refresh" size={13} color={colors.textSecondary} />
          </IconButton>
        )}
        <Button variant="ghost" size="sm" label="Today" onPress={() => setAnchor(new Date())} />
        {creatable.length > 0 ? (
          <IconButton label="New event" size="sm" onPress={newEvent}>
            <Icon name="plus" size={14} color={colors.textSecondary} />
          </IconButton>
        ) : null}
      </View>

      {/* An edit the provider refused because the event changed there first: its copy was kept. */}
      {conflicts.length > 0 ? (
        <View style={styles.notice}>
          <Text variant="caption" tone="secondary" style={{ flex: 1 }}>
            {conflicts.length === 1
              ? `“${conflicts[0].title}” was changed in another app before your edit arrived, so that version was kept.`
              : `${conflicts.length} events were changed in another app before your edits arrived, so those versions were kept.`}
          </Text>
          <Button variant="ghost" size="sm" label="Dismiss" onPress={dismissConflicts} />
        </View>
      ) : null}

      {/* Day header row */}
      <View style={[styles.headerRow, { paddingRight: scrollbarW }]}>
        <View style={{ width: GUTTER }} />
        {weekDays.map((d) => {
          const iso = toISODate(d);
          const isToday = iso === todayISO;
          return (
            <View key={iso} style={styles.headerCell}>
              <Text variant="mono" tone={isToday ? "accent" : "quaternary"} style={styles.dayName}>
                {DAY_NAMES[d.getDay()]}
              </Text>
              <View style={[styles.datePill, isToday ? { backgroundColor: colors.accent } : null]}>
                <Text variant="label" style={isToday ? { color: colors.onAccent } : null}>
                  {d.getDate()}
                </Text>
              </View>
            </View>
          );
        })}
      </View>

      {/* All-day band */}
      {hasAllDay ? (
        <View style={[styles.allDayRow, { paddingRight: scrollbarW }]}>
          <View style={styles.allDayGutter}>
            <Text variant="mono" tone="quaternary" style={styles.allDayLabel} numberOfLines={1}>
              all-day
            </Text>
          </View>
          {weekDays.map((d, di) => {
            const iso = toISODate(d);
            const all = byDay.get(iso)?.allDay ?? [];
            const shown = expandAllDay ? all : all.slice(0, ALL_DAY_MAX);
            const rest = all.length - shown.length;
            return (
              <View
                key={iso}
                style={[
                  styles.allDayCell,
                  iso === todayISO ? { backgroundColor: colors.accentSoft } : null,
                  hoverDay === di ? styles.columnLifted : null,
                ]}
              >
                {shown.map((it) => (
                  <AllDayChip key={it.id} item={it} dayIndex={di} onOpen={openItem} onHover={setDayHovered} />
                ))}
                {rest > 0 ? (
                  <BandLink label={`+${rest} more`} onPress={() => setExpandAllDay(true)} />
                ) : expandAllDay && all.length > ALL_DAY_MAX ? (
                  <BandLink label="show less" onPress={() => setExpandAllDay(false)} />
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}

      {/* Hour grid. minHeight:0 lets this flex child shrink below its content height so it
          actually scrolls instead of growing the screen (RNW/flexbox gotcha). */}
      <ScrollView ref={scrollRef} style={styles.scroll} contentContainerStyle={{ height: HOURS.length * ROW_H }} {...scrollProps}>
        <View style={styles.gridRow}>
          {/* hour gutter */}
          <View style={{ width: GUTTER }}>
            {HOURS.map((h) => (
              <View key={h} style={{ height: ROW_H }}>
                <Text variant="mono" tone="quaternary" style={styles.hourLabel}>
                  {hourLabel(h)}
                </Text>
              </View>
            ))}
          </View>
          {/* day columns */}
          {weekDays.map((d, di) => {
            const iso = toISODate(d);
            const isToday = iso === todayISO;
            const timed = byDay.get(iso)?.timed ?? [];
            const lanes = lanesByDay.get(iso);
            return (
              <View
                key={iso}
                ref={di === 0 ? colRef : undefined}
                style={[
                  styles.dayColumn,
                  isToday ? { backgroundColor: colors.accentSoft } : null,
                  hoverDay === di ? styles.columnLifted : null,
                ]}
              >
                {HOURS.map((h) => (
                  <View key={h} style={styles.hourCell} />
                ))}
                {timed.map((it) => (
                  <TimedBlock
                    key={it.id}
                    item={it}
                    dayIndex={di}
                    lane={lanes?.get(it.id)}
                    onOpen={openItem}
                    onReschedule={reschedule}
                    onResize={resize}
                    colWidth={colWidth}
                    onHover={setDayHovered}
                  />
                ))}
                {isToday ? <NowLine top={nowY} /> : null}
              </View>
            );
          })}
        </View>
      </ScrollView>
      {editor ? <EventEditorDialog target={editor} feeds={creatable} onClose={() => setEditor(null)} /> : null}
    </TourAnchor>
  );
}

/** One positioned block inside a day column. Hovering reveals a detail card; clicking a
 *  task/note opens it (feed events aren't linkable). Tasks are draggable — a drag past a
 *  small threshold moves the block and, on release, reschedules the task's due date/time;
 *  a plain tap still opens it. Concurrent blocks split the column into lanes; a hovered one
 *  takes the full width back so its title is readable without opening anything. The popover
 *  card flips left for the last columns. */
function TimedBlock({
  item,
  dayIndex,
  lane,
  onOpen,
  onReschedule,
  onResize,
  colWidth,
  onHover,
}: {
  item: CalendarItem;
  dayIndex: number;
  /** This block's lane within its overlap cluster (see layoutLanes). */
  lane?: Lane;
  onOpen: (item: CalendarItem) => void;
  onReschedule?: (item: CalendarItem, dayIndex: number, dx: number, dy: number) => void;
  /** Called with the vertical drag distance when the bottom edge is released. */
  onResize?: (item: CalendarItem, dy: number) => void;
  colWidth?: number;
  /** Tells the grid this block's column is active, so the column can lift above its
   *  neighbours while the hover card (or a drag) spills outside it. */
  onHover?: (dayIndex: number, on: boolean) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const movable = item.kind === "task" || (item.kind === "event" && !!item.editable && !item.recurring);
  const draggable = movable && !!onReschedule && !!colWidth;
  // Only events stretch here; a task's length is set in the Today agenda's day grid.
  const resizable = movable && item.kind === "event" && !!onResize;
  const [resizeDy, setResizeDy] = useState<number | null>(null);

  // A stable PanResponder that reads fresh props through a ref (mirrors useDraggable): claim
  // the gesture only once the pointer moves, so a tap still reaches the inner Pressable.
  const latest = useRef({ item, dayIndex, onReschedule, onResize, onHover });
  latest.current = { item, dayIndex, onReschedule, onResize, onHover };
  // Keep the column lift in sync with this block's own hover/drag state, and always release it
  // on unmount (stepping to another week while hovered would otherwise strand a lifted column).
  const setActive = useCallback((on: boolean) => latest.current.onHover?.(latest.current.dayIndex, on), []);
  useEffect(() => () => setActive(false), [setActive]);
  // Read by the drag handlers so releasing over the block keeps the column lifted for the
  // hover card that reappears underneath the cursor.
  const hoveredRef = useRef(false);
  // A drag ends with a synthetic click on web, which would fire the Pressable's onPress and
  // navigate. Record when a drag ended so that trailing press is ignored (a real tap much
  // later still opens the item).
  const lastDragEnd = useRef(0);
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_e, g: PanResponderGestureState) => Math.abs(g.dx) > 6 || Math.abs(g.dy) > 6,
        onPanResponderGrant: () => {
          setDrag({ dx: 0, dy: 0 });
          setActive(true);
        },
        onPanResponderMove: (_e, g: PanResponderGestureState) => setDrag({ dx: g.dx, dy: g.dy }),
        onPanResponderTerminationRequest: () => false,
        onPanResponderRelease: (_e, g: PanResponderGestureState) => {
          setDrag(null);
          setActive(hoveredRef.current);
          lastDragEnd.current = Date.now();
          latest.current.onReschedule?.(latest.current.item, latest.current.dayIndex, g.dx, g.dy);
        },
        onPanResponderTerminate: () => {
          setDrag(null);
          setActive(hoveredRef.current);
          lastDragEnd.current = Date.now();
        },
      }),
    [setActive],
  );

  // The resize handle is a separate responder on the block's bottom edge. It claims the gesture
  // at touch-down (the block's own move responder only claims after 6px of movement) and refuses
  // to give it up, so grabbing the edge never turns into dragging the whole block.
  const resizePan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          setResizeDy(0);
          setActive(true);
        },
        onPanResponderMove: (_e, g: PanResponderGestureState) => setResizeDy(g.dy),
        onPanResponderTerminationRequest: () => false,
        onPanResponderRelease: (_e, g: PanResponderGestureState) => {
          setResizeDy(null);
          setActive(hoveredRef.current);
          lastDragEnd.current = Date.now();
          latest.current.onResize?.(latest.current.item, g.dy);
        },
        onPanResponderTerminate: () => {
          setResizeDy(null);
          setActive(hoveredRef.current);
          lastDragEnd.current = Date.now();
        },
      }),
    [setActive],
  );

  const start = new Date(item.startsAt);
  const span = spanOf(item);
  const top = (span.start / 60) * ROW_H;
  const baseHeight = Math.max(ROW_H * 0.5, ((span.end - span.start) / 60) * ROW_H);
  // While the edge is held the block follows the pointer in the same 15-minute steps the drop
  // will land on, so what you see is what you get.
  const step = ROW_H / 4;
  const height =
    resizeDy === null
      ? baseHeight
      : Math.min(DAY_MIN / 60 * ROW_H - top, Math.max(step, Math.round((baseHeight + resizeDy) / step) * step));
  const k = KIND[item.kind];
  const flipLeft = dayIndex >= 4;
  const dragging = drag !== null || resizeDy !== null;

  const lanes = lane?.lanes ?? 1;
  const laneIndex = lane?.lane ?? 0;
  const share = 100 / lanes;
  // A hovered (or dragged) block in a split column takes the whole column back.
  const full = lanes > 1 && (hovered || dragging);
  // Short or narrow blocks run title and time on one line instead of stacking them.
  const tight = height < 26 || (lanes > 2 && !full);

  return (
    <View
      {...(draggable ? pan.panHandlers : {})}
      style={[
        styles.block,
        transition("left, width", motion.fast),
        {
          top: top + 1,
          height: height - 2,
          left: full ? ("0%" as const) : (`${laneIndex * share}%` as const),
          width: full ? ("100%" as const) : (`${share}%` as const),
          // Lanes keep a 2px channel between neighbours; the last one also clears the rule.
          paddingRight: full || laneIndex === lanes - 1 ? 2 : 0,
          // Later lanes sit above earlier ones; the lift for a hovered block belongs on this
          // positioned wrapper, not the inner card: the wrapper is the sibling that later
          // blocks in the column would otherwise paint over, card and all.
          zIndex: hovered ? 30 : 1 + laneIndex,
        },
        // A change still on its way to the calendar provider reads as not-quite-settled.
        item.pending ? { opacity: 0.6 } : null,
        drag ? { transform: [{ translateX: drag.dx }, { translateY: drag.dy }], zIndex: 60, opacity: 0.92 } : null,
        resizeDy !== null ? { zIndex: 60 } : null,
      ]}
    >
      <Pressable
        onHoverIn={() => {
          hoveredRef.current = true;
          setHovered(true);
          setActive(true);
        }}
        onHoverOut={() => {
          hoveredRef.current = false;
          setHovered(false);
          if (!dragging) setActive(false);
        }}
        onPress={() => {
          // Swallow the click that trails a drag (within a short window); a real tap opens it.
          if (Date.now() - lastDragEnd.current < 350) return;
          onOpen(item);
        }}
        style={styles.blockPress}
      >
        <View
          style={[
            styles.blockInner,
            tight ? styles.blockInnerTight : null,
            { backgroundColor: k.bg, borderLeftColor: item.color ?? k.bar },
            // A block only casts a shadow while it is in the air.
            dragging ? shadow.sm : null,
          ]}
        >
          <Text variant="caption" style={[styles.blockTitle, tight ? styles.blockTitleTight : null, { color: k.fg }]} numberOfLines={1}>
            {item.title || "Untitled"}
          </Text>
          <Text variant="mono" style={[styles.blockTime, { color: k.fg }]} numberOfLines={1}>
            {pad(start.getHours())}:{pad(start.getMinutes())}
          </Text>
        </View>
        {hovered && !dragging ? (
          <CalendarItemInfo
            item={item}
            maxHeight={260}
            style={[styles.popover, flipLeft ? styles.popoverLeft : styles.popoverRight]}
          />
        ) : null}
      </Pressable>
      {/* Outside the Pressable, so the click that trails a resize can't open the editor. */}
      {resizable ? <View {...resizePan.panHandlers} aria-label="Drag to change the end time" style={styles.resizeHandle} /> : null}
    </View>
  );
}

/** An all-day item (dated note or all-day event) in the band under the day headers. Like
 *  TimedBlock it reveals a detail card on hover and opens a task/note on click; its left bar
 *  uses the item's own kind/feed color so a note reads green here too. */
function AllDayChip({
  item,
  dayIndex,
  onOpen,
  onHover,
}: {
  item: CalendarItem;
  dayIndex: number;
  onOpen: (item: CalendarItem) => void;
  /** See TimedBlock: lifts the whole all-day cell so the card can spill into the next day. */
  onHover?: (dayIndex: number, on: boolean) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const openable = item.kind === "task" || item.kind === "note" || item.kind === "project" || !!item.editable;
  const flipRight = dayIndex >= 4;
  const latest = useRef({ dayIndex, onHover });
  latest.current = { dayIndex, onHover };
  const setActive = useCallback((on: boolean) => latest.current.onHover?.(latest.current.dayIndex, on), []);
  useEffect(() => () => setActive(false), [setActive]);
  return (
    <Pressable
      onHoverIn={() => {
        setHovered(true);
        setActive(true);
      }}
      onHoverOut={() => {
        setHovered(false);
        setActive(false);
      }}
      onPress={() => openable && onOpen(item)}
      style={({ pressed }: PressState) => [
        styles.allDayChip,
        transition("background-color", motion.instant),
        {
          borderLeftColor: item.color ?? KIND[item.kind].bar,
          backgroundColor: pressed && openable ? colors.surfaceActive : hovered ? colors.surfaceHover : colors.surfaceApp,
        },
        hovered ? styles.chipLifted : null,
      ]}
    >
      <Text variant="caption" tone="secondary" style={styles.allDayChipText} numberOfLines={1}>
        {item.title || "Untitled"}
      </Text>
      {hovered ? (
        <CalendarItemInfo
          item={item}
          maxHeight={260}
          style={[styles.popover, styles.popoverBelow, flipRight ? styles.popoverAnchorRight : styles.popoverAnchorLeft]}
        />
      ) : null}
    </Pressable>
  );
}

/** The mono "+N more" / "show less" toggle at the foot of an all-day cell. */
function BandLink({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      aria-label={label}
      style={({ hovered, pressed }: PressState) => [
        styles.bandLink,
        { backgroundColor: pressed ? colors.surfaceActive : hovered ? colors.surfaceHover : "transparent" },
      ]}
    >
      <Text variant="mono" tone="tertiary" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** The current-time indicator drawn across today's column: a 2px accent rule with a 7px dot
 *  at its left edge, positioned at `top` pixels (the minutes-since-midnight offset). */
function NowLine({ top }: { top: number }) {
  return (
    <View style={[styles.nowLine, { top }]} pointerEvents="none">
      <View style={styles.nowDot} />
    </View>
  );
}

function Legend() {
  const dot = (color: string, label: string) => (
    <View style={styles.legendItem} key={label}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text variant="mono" tone="tertiary">
        {label}
      </Text>
    </View>
  );
  return (
    <View style={styles.legend}>
      {dot(colors.textPrimary, "events")}
      {dot(colors.info, "tasks")}
      {dot(colors.success, "notes")}
      {dot(colors.accent, "projects")}
    </View>
  );
}

const styles = {
  root: { flex: 1, minHeight: 0, backgroundColor: colors.surfaceCard },
  scroll: { flex: 1, minHeight: 0 },
  toolbar: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    height: TOOLBAR_H,
    paddingHorizontal: space.ml,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    flexShrink: 0,
  },
  navGroup: { flexDirection: "row" as const, gap: 1 },
  toolbarDivider: { height: 14 },
  legend: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.ml },
  legendItem: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.xs },
  legendDot: { width: 7, height: 7, borderRadius: radius.sm },
  // Holds the refresh button's footprint while the spinner stands in for it.
  // The bottom 6px of an editable event. Invisible: the ns-resize cursor is the affordance, as
  // in every desktop calendar.
  resizeHandle: {
    position: "absolute" as const,
    left: 0,
    right: 0,
    bottom: 0,
    height: 6,
    zIndex: 2,
    cursor: "ns-resize",
  } as Record<string, unknown>,
  notice: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.xs,
    backgroundColor: colors.surfaceSunken,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  refreshSlot: { width: control.sm, height: control.sm, alignItems: "center" as const, justifyContent: "center" as const },

  headerRow: {
    flexDirection: "row" as const,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    flexShrink: 0,
  },
  headerCell: {
    flex: 1,
    minWidth: 0,
    alignItems: "center" as const,
    gap: 1,
    paddingTop: space.xs,
    paddingBottom: 5,
    borderLeftWidth: 1,
    borderLeftColor: colors.borderSubtle,
  },
  dayName: { fontSize: font.size["2xs"], textTransform: "uppercase" as const, letterSpacing: font.tracking.wide },
  // A numeral in a count-style pill: fully round, like every other numeric count.
  datePill: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: space.xs,
    borderRadius: radius.full,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },

  allDayRow: {
    flexDirection: "row" as const,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    flexShrink: 0,
    // Lift the whole band above the hour grid (a later sibling) so an all-day chip's hover
    // popover, which drops down into the grid area, isn't painted over by it. A chip's own
    // popover zIndex only competes within this band's stacking context.
    zIndex: 20,
  },
  allDayGutter: { width: GUTTER, alignItems: "flex-end" as const, paddingRight: space.xxs, paddingTop: 7 },
  allDayLabel: { fontSize: 9 },
  allDayCell: {
    flex: 1,
    minWidth: 0,
    minHeight: 26,
    borderLeftWidth: 1,
    borderLeftColor: colors.borderSubtle,
    paddingVertical: space.xs,
    paddingHorizontal: 3,
    gap: 2,
  },
  allDayChip: {
    height: 18,
    justifyContent: "center" as const,
    borderLeftWidth: 2,
    borderRadius: radius.sm,
    paddingHorizontal: 5,
  },
  allDayChipText: { fontWeight: font.weight.medium },
  bandLink: { height: 14, justifyContent: "center" as const, paddingHorizontal: 5, borderRadius: radius.sm },

  gridRow: { flexDirection: "row" as const },
  hourLabel: { fontSize: font.size["2xs"], textAlign: "right" as const, paddingRight: space.sm, marginTop: -5 },
  dayColumn: {
    flex: 1,
    minWidth: 0,
    position: "relative" as const,
    borderLeftWidth: 1,
    borderLeftColor: colors.borderSubtle,
  },
  hourCell: { height: ROW_H, borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  // Applied to the hovered day column (and its all-day cell): every RNW View is its own
  // stacking context, so a card that spills sideways only clears the neighbouring columns
  // once the column holding it outranks them.
  columnLifted: { zIndex: 40 },
  // The positioned outer container (lane geometry and the drag transform ride here); the
  // inner holds the visual.
  block: { position: "absolute" as const, paddingLeft: 2 },
  // The hover target. It doesn't clip, so the detail card can hang off its edge.
  blockPress: { flex: 1 },
  blockInner: {
    flex: 1,
    overflow: "hidden" as const,
    borderLeftWidth: 2,
    borderRadius: radius.sm,
    paddingHorizontal: space.xs,
    paddingVertical: space.xxs,
  },
  blockInnerTight: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.xs, paddingVertical: 0 },
  blockTitle: { fontWeight: font.weight.semibold },
  blockTitleTight: { flex: 1, minWidth: 0 },
  blockTime: { fontSize: 9, lineHeight: 12, opacity: 0.75, flexShrink: 0 },
  // A hovered chip rises above its siblings inside the cell so its card isn't covered by a
  // later chip; the cell itself rises via columnLifted.
  chipLifted: { zIndex: 30 },

  popover: { position: "absolute" as const, top: 0, width: CARD_W, zIndex: 40 },
  popoverRight: { left: "100%" as const, marginLeft: space.sm },
  popoverLeft: { right: "100%" as const, marginRight: space.sm },
  // All-day chips are in a shallow band, so their card drops below and anchors to an edge.
  popoverBelow: { top: "100%" as const, marginTop: space.xs },
  popoverAnchorLeft: { left: 0 },
  popoverAnchorRight: { right: 0 },

  nowLine: {
    position: "absolute" as const,
    left: 0,
    right: 0,
    height: 0,
    borderTopWidth: 2,
    borderTopColor: colors.accent,
    zIndex: 5,
  },
  nowDot: {
    position: "absolute" as const,
    left: -3,
    top: -4,
    width: 7,
    height: 7,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
};
