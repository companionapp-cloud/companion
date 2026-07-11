import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, PanResponder, Pressable, ScrollView, View, type PanResponderGestureState } from "react-native";
import type { CalendarItem, CalendarItemKind } from "@companion/core-bridge";
import { Button, Icon, IconButton, Text, colors, radius, space } from "@companion/design-system";
import { useCalendar } from "./CalendarProvider";
import { CalendarItemInfo } from "./CalendarItemInfo";
import { useTasks } from "./TasksProvider";
import { useNav } from "./nav-context";

// The Calendar tool (PLAN §6.7): a week grid of merged events, due tasks, and dated notes,
// mirroring the prototype's CalendarView. Habit streaks join it when habits (§16) land.

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ROW_H = 48;
const GUTTER = 52;
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

// Per-kind block palette. Events lean dark/neutral (tinted by their feed color on the left
// bar), tasks read blue, dated notes take the success green — matching the legend and
// the agenda dot so a note reads the same everywhere.
const KIND: Record<CalendarItemKind, { bg: string; fg: string; bar: string }> = {
  event: { bg: colors.gray900, fg: colors.gray0, bar: colors.gray600 },
  task: { bg: colors.infoSoft, fg: colors.infoActive, bar: colors.info },
  note: { bg: colors.surfaceApp, fg: colors.textSecondary, bar: colors.success },
};

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

export function CalendarScreen() {
  const { range, revision, refresh, getViewState, setViewState } = useCalendar();
  const tasks = useTasks();
  const nav = useNav();
  // Tasks and notes open in a new workspace tab; feed events aren't linkable (read-only, no
  // local entity) — they surface their detail via the hover card instead.
  const openItem = (item: CalendarItem) => {
    if (item.kind === "task" || item.kind === "note") nav.openInNewTab({ kind: item.kind, id: item.sourceId });
  };
  // Restore the last visible week (persisted on the provider so it survives navigating away).
  const [anchor, setAnchor] = useState(() => {
    const saved = getViewState().anchorMs;
    return saved != null ? new Date(saved) : new Date();
  });
  const [items, setItems] = useState<CalendarItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  // A day column's pixel width, measured via a ref (this RN typing has no onLayout on View,
  // so measure like useDropTarget does) — drag-to-reschedule maps horizontal drag distance to
  // a number of days.
  const [colWidth, setColWidth] = useState(0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const colRef = useRef<any>(null);

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
  const todayISO = toISODate(new Date());

  // Drag-to-reschedule a task: translate the drop's day/time delta into a new due instant,
  // snap to 15 minutes, update the task (optimistically move the block so it doesn't jump),
  // and let the follow-up sync re-query reconcile it (PLAN §6.4/§6.7). Only tasks are
  // draggable — events are read-only clones and notes are date-only markers.
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
      void tasks.update(item.sourceId, { dueAt: iso });
    },
    [colWidth, weekDays, tasks],
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
    };
    const id = setTimeout(measure, 0);
    if (typeof window !== "undefined") {
      window.addEventListener("resize", measure);
      return () => {
        clearTimeout(id);
        window.removeEventListener("resize", measure);
      };
    }
    return () => clearTimeout(id);
  }, [weekStart]);

  // A ticking clock so the "now" line tracks real time (updated each minute).
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const nowY = (now.getHours() * 60 + now.getMinutes()) / 60 * ROW_H;

  useEffect(() => {
    let alive = true;
    const from = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate());
    const to = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7);
    void range(from.toISOString(), to.toISOString()).then((list) => {
      if (alive) setItems(list);
    });
    return () => {
      alive = false;
    };
  }, [weekStart, range, revision]);

  // Bucket items per weekday ISO, split into all-day (note markers, all-day events) and
  // timed. The grid always spans the full day (00:00–24:00) and scrolls.
  const byDay = useMemo(() => {
    const map = new Map<string, { allDay: CalendarItem[]; timed: CalendarItem[] }>();
    for (const d of weekDays) map.set(toISODate(d), { allDay: [], timed: [] });
    for (const it of items) {
      // All-day items (dated notes, all-day events) carry a date-only marker stored as
      // midnight UTC; converting that instant to local time would shift it a day in some
      // zones, so bucket them by the date portion directly. Timed items use their instant.
      const iso = it.allDay ? it.startsAt.slice(0, 10) : toISODate(new Date(it.startsAt));
      const bucket = map.get(iso);
      if (!bucket) continue;
      (it.allDay ? bucket.allDay : bucket.timed).push(it);
    }
    return map;
  }, [items, weekDays]);

  const hasAllDay = useMemo(() => weekDays.some((d) => (byDay.get(toISODate(d))?.allDay.length ?? 0) > 0), [byDay, weekDays]);
  const monthLabel = `${MONTHS[weekStart.getMonth()]} ${weekStart.getFullYear()}`;

  const stepWeek = (delta: number) =>
    setAnchor((a) => new Date(a.getFullYear(), a.getMonth(), a.getDate() + delta * 7));

  // On first open, restore the persisted scroll offset; if there is none, scroll the
  // current-time line into view (or the morning if today isn't in the visible week) so the
  // full 24h grid never strands the user at midnight. Runs once — switching weeks keeps the
  // user's scroll position rather than jumping. The ScrollView ref type differs between the
  // RN and RN-web typings, so keep it loose; scrollTo exists on both at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scrollRef = useRef<any>(null);
  useEffect(() => {
    const saved = getViewState().scrollY;
    let y = saved;
    if (!(saved > 0)) {
      const d = new Date();
      const inWeek = weekDays.some((wd) => toISODate(wd) === toISODate(d));
      const target = inWeek ? (d.getHours() * 60 + d.getMinutes()) / 60 * ROW_H : DEFAULT_SCROLL_HOUR * ROW_H;
      y = Math.max(0, target - 3 * ROW_H);
    }
    // Run a tick after layout so content is measured.
    const id = setTimeout(() => scrollRef.current?.scrollTo({ y, animated: false }), 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // onScroll / scrollEventThrottle aren't in this stripped RN ScrollView typing, but RNW
  // supports them at runtime; pass them through a loosely-typed spread. Persist the offset so
  // returning to the calendar restores the scroll.
  const scrollProps = {
    scrollEventThrottle: 64,
    onScroll: (e: { nativeEvent: { contentOffset: { y: number } } }) => setViewState({ scrollY: e.nativeEvent.contentOffset.y }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return (
    <View style={styles.root}>
      {/* Toolbar: month, week nav, legend, jump-to-today */}
      <View style={styles.toolbar}>
        <Icon name="calendar" size={18} color={colors.textSecondary} />
        <Text style={styles.monthTitle}>{monthLabel}</Text>
        <View style={styles.navGroup}>
          <IconButton label="Previous week" size="sm" onPress={() => stepWeek(-1)}>
            <Icon name="chevronLeft" size={18} color={colors.textSecondary} />
          </IconButton>
          <IconButton label="Next week" size="sm" onPress={() => stepWeek(1)}>
            <Icon name="chevronRight" size={18} color={colors.textSecondary} />
          </IconButton>
        </View>
        <Legend />
        <View style={{ flex: 1 }} />
        <IconButton label="Refresh calendars" size="sm" onPress={onRefresh} disabled={refreshing}>
          {refreshing ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : (
            <Icon name="refresh" size={16} color={colors.textSecondary} />
          )}
        </IconButton>
        <Button variant="ghost" size="sm" label="Today" onPress={() => setAnchor(new Date())} />
      </View>

      {/* Day header row */}
      <View style={styles.headerRow}>
        <View style={{ width: GUTTER }} />
        {weekDays.map((d) => {
          const iso = toISODate(d);
          const isToday = iso === todayISO;
          return (
            <View key={iso} style={styles.headerCell}>
              <Text
                variant="mono"
                style={[styles.dayName, { color: isToday ? colors.accentHover : colors.textTertiary }]}
              >
                {DAY_NAMES[d.getDay()]}
              </Text>
              <View style={[styles.datePill, isToday ? { backgroundColor: colors.accent } : null]}>
                <Text style={{ color: isToday ? colors.onAccent : colors.textPrimary, fontWeight: "600" }}>
                  {d.getDate()}
                </Text>
              </View>
            </View>
          );
        })}
      </View>

      {/* All-day strip */}
      {hasAllDay ? (
        <View style={styles.allDayRow}>
          <View style={[styles.gutterCell, { justifyContent: "center" }]}>
            <Text variant="mono" tone="tertiary" style={styles.allDayLabel}>
              all-day
            </Text>
          </View>
          {weekDays.map((d, di) => {
            const iso = toISODate(d);
            const all = byDay.get(iso)?.allDay ?? [];
            return (
              <View key={iso} style={styles.allDayCell}>
                {all.map((it) => (
                  <AllDayChip key={it.id} item={it} dayIndex={di} onOpen={openItem} />
                ))}
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
                <Text variant="mono" tone="tertiary" style={styles.hourLabel}>
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
            return (
              <View
                key={iso}
                ref={di === 0 ? colRef : undefined}
                style={[styles.dayColumn, isToday ? { backgroundColor: colors.accentSoft } : null]}
              >
                {HOURS.map((h) => (
                  <View key={h} style={styles.hourCell} />
                ))}
                {timed.map((it) => (
                  <TimedBlock key={it.id} item={it} dayIndex={di} onOpen={openItem} onReschedule={reschedule} colWidth={colWidth} />
                ))}
                {isToday ? <NowLine top={nowY} /> : null}
              </View>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

/** One positioned block inside a day column. Hovering reveals a detail card; clicking a
 *  task/note opens it (feed events aren't linkable). Tasks are draggable — a drag past a
 *  small threshold moves the block and, on release, reschedules the task's due date/time;
 *  a plain tap still opens it. The popover card flips left for the last columns. */
function TimedBlock({
  item,
  dayIndex,
  onOpen,
  onReschedule,
  colWidth,
}: {
  item: CalendarItem;
  dayIndex: number;
  onOpen: (item: CalendarItem) => void;
  onReschedule?: (item: CalendarItem, dayIndex: number, dx: number, dy: number) => void;
  colWidth?: number;
}) {
  const [hovered, setHovered] = useState(false);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const draggable = item.kind === "task" && !!onReschedule && !!colWidth;

  // A stable PanResponder that reads fresh props through a ref (mirrors useDraggable): claim
  // the gesture only once the pointer moves, so a tap still reaches the inner Pressable.
  const latest = useRef({ item, dayIndex, onReschedule });
  latest.current = { item, dayIndex, onReschedule };
  // A drag ends with a synthetic click on web, which would fire the Pressable's onPress and
  // navigate. Record when a drag ended so that trailing press is ignored (a real tap much
  // later still opens the item).
  const lastDragEnd = useRef(0);
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_e, g: PanResponderGestureState) => Math.abs(g.dx) > 6 || Math.abs(g.dy) > 6,
        onPanResponderGrant: () => setDrag({ dx: 0, dy: 0 }),
        onPanResponderMove: (_e, g: PanResponderGestureState) => setDrag({ dx: g.dx, dy: g.dy }),
        onPanResponderTerminationRequest: () => false,
        onPanResponderRelease: (_e, g: PanResponderGestureState) => {
          setDrag(null);
          lastDragEnd.current = Date.now();
          latest.current.onReschedule?.(latest.current.item, latest.current.dayIndex, g.dx, g.dy);
        },
        onPanResponderTerminate: () => {
          setDrag(null);
          lastDragEnd.current = Date.now();
        },
      }),
    [],
  );

  const start = new Date(item.startsAt);
  const startHours = start.getHours() + start.getMinutes() / 60;
  let durationH = 1;
  if (item.endsAt) {
    const end = new Date(item.endsAt);
    durationH = Math.max(0.5, (end.getTime() - start.getTime()) / 3_600_000);
  }
  const top = startHours * ROW_H;
  const height = durationH * ROW_H;
  const k = KIND[item.kind];
  const p = (n: number) => String(n).padStart(2, "0");
  const flipLeft = dayIndex >= 4;
  const dragging = drag !== null;

  return (
    <View
      {...(draggable ? pan.panHandlers : {})}
      style={[
        styles.block,
        { top: top + 2, height: height - 4 },
        dragging ? { transform: [{ translateX: drag.dx }, { translateY: drag.dy }], zIndex: 60, opacity: 0.92 } : null,
      ]}
    >
      <Pressable
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onPress={() => {
          // Swallow the click that trails a drag (within a short window); a real tap opens it.
          if (Date.now() - lastDragEnd.current < 350) return;
          onOpen(item);
        }}
        style={[
          styles.blockInner,
          { backgroundColor: k.bg, borderLeftColor: item.color ?? k.bar },
          hovered || dragging ? styles.blockHovered : null,
        ]}
      >
        <Text style={[styles.blockTitle, { color: k.fg }]} numberOfLines={1}>
          {item.title || "Untitled"}
        </Text>
        <Text style={[styles.blockTime, { color: k.fg }]} numberOfLines={1}>
          {p(start.getHours())}:{p(start.getMinutes())}
        </Text>
        {hovered && !dragging ? (
          <CalendarItemInfo
            item={item}
            maxHeight={260}
            style={[styles.popover, flipLeft ? styles.popoverLeft : styles.popoverRight]}
          />
        ) : null}
      </Pressable>
    </View>
  );
}

/** An all-day item (dated note or all-day event) in the strip under the day headers. Like
 *  TimedBlock it reveals a detail card on hover and opens a task/note on click; its left bar
 *  uses the item's own kind/feed color so a note reads green here too. */
function AllDayChip({ item, dayIndex, onOpen }: { item: CalendarItem; dayIndex: number; onOpen: (item: CalendarItem) => void }) {
  const [hovered, setHovered] = useState(false);
  const openable = item.kind === "task" || item.kind === "note";
  const flipRight = dayIndex >= 4;
  return (
    <Pressable
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={() => openable && onOpen(item)}
      style={[styles.allDayChip, { borderLeftColor: item.color ?? KIND[item.kind].bar }, hovered ? styles.blockHovered : null]}
    >
      <Text style={styles.allDayChipText} numberOfLines={1}>
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

/** The current-time indicator drawn across today's column: a thin accent line with a dot at
 *  its left edge, positioned at `top` pixels (the minutes-since-midnight offset). */
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
      <Text variant="mono" tone="tertiary" style={{ fontSize: 11 }}>
        {label}
      </Text>
    </View>
  );
  return (
    <View style={styles.legend}>
      {dot(colors.gray700, "Events")}
      {dot(colors.info, "Tasks")}
      {dot(colors.success, "Notes")}
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
    height: 48,
    paddingHorizontal: space.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    flexShrink: 0,
  },
  monthTitle: { fontSize: 15, fontWeight: "600" as const },
  navGroup: { flexDirection: "row" as const, gap: 2 },
  legend: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.lg, marginLeft: space.md },
  legendItem: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.xs },
  legendDot: { width: 8, height: 8, borderRadius: 3 },

  headerRow: {
    flexDirection: "row" as const,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    flexShrink: 0,
  },
  headerCell: {
    flex: 1,
    alignItems: "center" as const,
    paddingVertical: space.sm,
    borderLeftWidth: 1,
    borderLeftColor: colors.borderSubtle,
  },
  dayName: { fontSize: 11, textTransform: "uppercase" as const, letterSpacing: 0.5 },
  datePill: {
    minWidth: 26,
    height: 26,
    marginTop: 2,
    paddingHorizontal: 4,
    borderRadius: radius.full,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },

  allDayRow: {
    flexDirection: "row" as const,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    minHeight: 30,
    flexShrink: 0,
    // Lift the whole strip above the hour grid (a later sibling) so an all-day chip's hover
    // popover, which drops down into the grid area, isn't painted over by it. A chip's own
    // popover zIndex only competes within this strip's stacking context.
    zIndex: 20,
  },
  gutterCell: { width: GUTTER, alignItems: "flex-end" as const, paddingRight: space.sm },
  allDayLabel: { fontSize: 10 },
  allDayCell: {
    flex: 1,
    borderLeftWidth: 1,
    borderLeftColor: colors.borderSubtle,
    padding: 2,
    gap: 2,
  },
  allDayChip: {
    backgroundColor: colors.surfaceApp,
    borderLeftWidth: 2,
    borderRadius: radius.sm,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  allDayChipText: { fontSize: 11, color: colors.textSecondary },

  gridRow: { flexDirection: "row" as const },
  hourLabel: { fontSize: 10, textAlign: "right" as const, paddingRight: space.sm, marginTop: -6 },
  dayColumn: {
    flex: 1,
    position: "relative" as const,
    borderLeftWidth: 1,
    borderLeftColor: colors.borderSubtle,
  },
  hourCell: { height: ROW_H, borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  // The positioned outer container (drag transform rides here); the inner holds the visual.
  block: {
    position: "absolute" as const,
    left: 3,
    right: 3,
  },
  blockInner: {
    flex: 1,
    borderLeftWidth: 2,
    borderRadius: radius.md,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  // A hovered/dragging block lifts above its neighbours so its popover isn't covered.
  blockHovered: { zIndex: 30, boxShadow: "0 1px 6px rgba(0,0,0,0.18)" },
  blockTitle: { fontSize: 12, fontWeight: "600" as const },
  blockTime: { fontSize: 9, opacity: 0.75, marginTop: 1 },

  popover: { position: "absolute" as const, top: 0, width: 240, zIndex: 40 },
  popoverRight: { left: "100%" as const, marginLeft: 8 },
  popoverLeft: { right: "100%" as const, marginRight: 8 },
  // All-day chips are in a shallow strip, so their card drops below and anchors to an edge.
  popoverBelow: { top: "100%" as const, marginTop: 4 },
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
    left: -4,
    top: -4,
    width: 8,
    height: 8,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
};
