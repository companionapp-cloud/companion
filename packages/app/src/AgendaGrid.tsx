import { useEffect, useMemo, useRef, useState } from "react";
import { PanResponder, Pressable, ScrollView, View, type PanResponderGestureState } from "react-native";
import type { CalendarItemKind } from "@companion/core-bridge";
import { Text, colors, font, motion, radius, shadow, space, transition, type PressState } from "@companion/design-system";
import { DAY_MIN, KIND, layoutLanes, type Lane } from "./calendarLayout";

// The Today agenda's day grid (PLAN-agenda.md): what fits inside the day, in one column, midnight to midnight, ruled every
// fifteen minutes — the step everything in it moves and stretches by. A sibling of the Calendar
// tool's week grid, grown taller: there an hour is 34px and a quarter is too small to draw;
// here a quarter hour is a row you can see, point at and drop something on.

/** One quarter-hour row. */
const SLOT_H = 14;
const SLOT_MIN = 15;
const HOUR_H = SLOT_H * 4;
const GUTTER = 40;
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const QUARTERS = [0, 1, 2, 3];
// Where the grid opens when the day isn't today and holds nothing earlier (~7am).
const DEFAULT_SCROLL_HOUR = 7;

/** Something drawn in the grid: a calendar event, or a task from its start to its deadline. */
export interface GridBlock {
  id: string;
  kind: CalendarItemKind;
  title: string;
  startsAt: string;
  /** Absent for an event with no end, which reads as an hour. */
  endsAt?: string | null;
  /** An event's feed color, on the left bar. */
  color?: string | null;
  /** Can be dragged to another time and stretched from its bottom edge. */
  movable: boolean;
  /** A change still on its way to the calendar provider. */
  pending?: boolean;
  /** A finished task: struck through and faded. */
  done?: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Minutes since midnight → 'HH:mm' ('24:00' for the end of the day). */
export const clockLabel = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

/** '12a', '9a', '12p', '3p' for an hour 0–23. */
function hourLabel(h: number): string {
  if (h === 0) return "12a";
  if (h < 12) return `${h}a`;
  if (h === 12) return "12p";
  return `${h - 12}p`;
}

/** Local minutes since midnight of an instant. */
function minutesOf(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

const snap = (min: number) => Math.round(min / SLOT_MIN) * SLOT_MIN;

export function AgendaGrid({
  date,
  blocks,
  visible = true,
  onPressBlock,
  onMove,
  onPressSlot,
}: {
  /** The day shown, 'YYYY-MM-DD'. */
  date: string;
  blocks: GridBlock[];
  /** False while the tab sits in the background: pauses the clock and defers the first scroll. */
  visible?: boolean;
  onPressBlock?: (block: GridBlock) => void;
  /** A block was dropped at a new time, or its bottom edge released: its new instants. */
  onMove?: (block: GridBlock, startsAt: string, endsAt: string) => void;
  /** An empty quarter hour was clicked: minutes since midnight. */
  onPressSlot?: (minutes: number) => void;
}) {
  // A ticking clock so the "now" line tracks real time; only a visible tab keeps it.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!visible) return;
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, [visible]);
  const isToday = date === `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const lanes = useMemo(() => layoutLanes(blocks, SLOT_MIN), [blocks]);

  // Open on what matters: the current time today, else the day's first block, else the
  // morning. Once, the first time the grid is actually on screen (a hidden pane can't scroll);
  // changing days keeps the scroll, since the hours of interest rarely change with the day.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scrollRef = useRef<any>(null);
  const didScroll = useRef(false);
  const firstStart = blocks.length ? Math.min(...blocks.map((b) => minutesOf(b.startsAt))) : null;
  useEffect(() => {
    if (!visible || didScroll.current) return;
    const target = isToday ? nowMin : Math.min(firstStart ?? DAY_MIN, DEFAULT_SCROLL_HOUR * 60);
    const id = setTimeout(() => {
      didScroll.current = true;
      scrollRef.current?.scrollTo({ y: Math.max(0, (target / 60 - 1.5) * HOUR_H), animated: false });
    }, 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  return (
    <ScrollView ref={scrollRef} style={styles.scroll} contentContainerStyle={styles.content}>
      <View style={styles.gridRow}>
        <View style={{ width: GUTTER }}>
          {HOURS.map((h) => (
            <View key={h} style={{ height: HOUR_H }}>
              <Text variant="mono" tone="quaternary" style={styles.hourLabel}>
                {hourLabel(h)}
              </Text>
            </View>
          ))}
        </View>
        <View style={styles.column}>
          {HOURS.map((h) =>
            QUARTERS.map((q) => <Slot key={h * 4 + q} minutes={h * 60 + q * SLOT_MIN} quarter={q} onPress={onPressSlot} />),
          )}
          {blocks.map((b) => (
            <Block key={b.id} block={b} lane={lanes.get(b.id)} onPress={onPressBlock} onMove={onMove} />
          ))}
          {isToday ? (
            <View style={[styles.nowLine, { top: (nowMin / 60) * HOUR_H }]} pointerEvents="none">
              <View style={styles.nowDot} />
            </View>
          ) : null}
        </View>
      </View>
    </ScrollView>
  );
}

/** One quarter-hour row of the column. The rule above it is firm on the hour, lighter on the
 *  half, faint on the quarters; hovering lights the row a click would add a task at. */
function Slot({ minutes, quarter, onPress }: { minutes: number; quarter: number; onPress?: (minutes: number) => void }) {
  return (
    <Pressable
      disabled={!onPress}
      onPress={() => onPress?.(minutes)}
      aria-label={`Add a task at ${clockLabel(minutes)}`}
      style={({ hovered }: PressState) => [
        styles.slot,
        quarter === 0 ? styles.slotHour : quarter === 2 ? styles.slotHalf : styles.slotQuarter,
        hovered && onPress ? { backgroundColor: colors.surfaceHover } : null,
      ]}
    />
  );
}

/** One positioned block. A drag past a small threshold moves it, the bottom edge stretches it —
 *  both in quarter-hour steps, previewed live with the times they will land on — and a plain
 *  press opens it. Concurrent blocks split the column into lanes; one being handled takes the
 *  full width back. */
function Block({
  block,
  lane,
  onPress,
  onMove,
}: {
  block: GridBlock;
  lane?: Lane;
  onPress?: (block: GridBlock) => void;
  onMove?: (block: GridBlock, startsAt: string, endsAt: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [dragDy, setDragDy] = useState<number | null>(null);
  const [resizeDy, setResizeDy] = useState<number | null>(null);
  const movable = block.movable && !!onMove;

  const startMin = minutesOf(block.startsAt);
  const durationMs = block.endsAt ? Math.max(SLOT_MIN * 60_000, new Date(block.endsAt).getTime() - new Date(block.startsAt).getTime()) : 60 * 60_000;
  const lenMin = Math.round(durationMs / 60_000);

  // What the gesture in progress would do, in the same steps the release lands on.
  const movedStart = (dy: number) => Math.min(DAY_MIN - SLOT_MIN, Math.max(0, snap(startMin + (dy / HOUR_H) * 60)));
  const resizedLen = (dy: number) => Math.min(DAY_MIN - startMin, Math.max(SLOT_MIN, snap(lenMin + (dy / HOUR_H) * 60)));
  const shownStart = dragDy !== null ? movedStart(dragDy) : startMin;
  const shownLen = resizeDy !== null ? resizedLen(resizeDy) : lenMin;

  // Stable responders that read fresh values through a ref (mirrors the week grid's blocks).
  const latest = useRef({ block, onMove, movedStart, resizedLen, startMin, durationMs });
  latest.current = { block, onMove, movedStart, resizedLen, startMin, durationMs };
  // A drag ends with a synthetic click on web; remember when, so that press is ignored.
  const lastGestureEnd = useRef(0);

  const commit = (start: number, ms: number) => {
    const { block: b, onMove: move } = latest.current;
    const base = new Date(b.startsAt);
    const startsAt = new Date(base.getFullYear(), base.getMonth(), base.getDate(), Math.floor(start / 60), start % 60);
    const endsAt = new Date(startsAt.getTime() + ms);
    if (startsAt.toISOString() === b.startsAt && endsAt.toISOString() === (b.endsAt ?? "")) return;
    move?.(b, startsAt.toISOString(), endsAt.toISOString());
  };

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_e, g: PanResponderGestureState) => Math.abs(g.dy) > 4,
        onPanResponderGrant: () => setDragDy(0),
        onPanResponderMove: (_e, g: PanResponderGestureState) => setDragDy(g.dy),
        onPanResponderTerminationRequest: () => false,
        onPanResponderRelease: (_e, g: PanResponderGestureState) => {
          setDragDy(null);
          lastGestureEnd.current = Date.now();
          commit(latest.current.movedStart(g.dy), latest.current.durationMs);
        },
        onPanResponderTerminate: () => {
          setDragDy(null);
          lastGestureEnd.current = Date.now();
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // The bottom edge claims the gesture at touch-down, so grabbing it never drags the block.
  const resizePan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: () => setResizeDy(0),
        onPanResponderMove: (_e, g: PanResponderGestureState) => setResizeDy(g.dy),
        onPanResponderTerminationRequest: () => false,
        onPanResponderRelease: (_e, g: PanResponderGestureState) => {
          setResizeDy(null);
          lastGestureEnd.current = Date.now();
          commit(latest.current.startMin, latest.current.resizedLen(g.dy) * 60_000);
        },
        onPanResponderTerminate: () => {
          setResizeDy(null);
          lastGestureEnd.current = Date.now();
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const handling = dragDy !== null || resizeDy !== null;
  const top = (shownStart / 60) * HOUR_H;
  const height = Math.max(SLOT_H, (Math.min(shownLen, DAY_MIN - shownStart) / 60) * HOUR_H);
  const lanes = lane?.lanes ?? 1;
  const laneIndex = lane?.lane ?? 0;
  const share = 100 / lanes;
  const full = lanes > 1 && (hovered || handling);
  // A quarter- or half-hour block runs title and times on one line.
  const tight = height < SLOT_H * 3;
  const k = KIND[block.kind];

  return (
    <View
      {...(movable ? pan.panHandlers : {})}
      style={[
        styles.block,
        transition("left, width", motion.fast),
        {
          top: top + 1,
          height: height - 1,
          left: full ? ("0%" as const) : (`${laneIndex * share}%` as const),
          width: full ? ("100%" as const) : (`${share}%` as const),
          paddingRight: full || laneIndex === lanes - 1 ? 4 : 0,
          zIndex: handling ? 60 : hovered ? 30 : 1 + laneIndex,
        },
        block.pending || block.done ? { opacity: 0.6 } : null,
      ]}
    >
      <Pressable
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onPress={() => {
          if (Date.now() - lastGestureEnd.current < 350) return;
          onPress?.(block);
        }}
        aria-label={`${block.title || "Untitled"}, ${clockLabel(shownStart)} to ${clockLabel(shownStart + shownLen)}`}
        style={[
          styles.blockInner,
          tight ? styles.blockInnerTight : null,
          { backgroundColor: k.bg, borderLeftColor: block.color ?? k.bar },
          handling ? shadow.sm : null,
          movable ? styles.grab : null,
        ]}
      >
        <Text
          variant="caption"
          style={[styles.blockTitle, tight ? styles.blockTitleTight : null, { color: k.fg }, block.done ? styles.struck : null]}
          numberOfLines={1}
        >
          {block.title || "Untitled"}
        </Text>
        <Text variant="mono" style={[styles.blockTime, { color: k.fg }]} numberOfLines={1}>
          {clockLabel(shownStart)}–{clockLabel(shownStart + shownLen)}
        </Text>
      </Pressable>
      {/* Outside the Pressable, so the click that trails a resize can't open the block. */}
      {movable ? <View {...resizePan.panHandlers} aria-label="Drag to change the end time" style={styles.resizeHandle} /> : null}
    </View>
  );
}

const styles = {
  // minHeight:0 lets this flex child shrink below its content height so it scrolls instead of
  // growing the pane (RNW/flexbox gotcha).
  scroll: { flex: 1, minHeight: 0 },
  content: { height: HOURS.length * HOUR_H + space.md, paddingTop: space.md },
  gridRow: { flexDirection: "row" as const },
  hourLabel: { fontSize: font.size["2xs"], textAlign: "right" as const, paddingRight: space.sm, marginTop: -5 },
  column: { flex: 1, minWidth: 0, position: "relative" as const },
  slot: { height: SLOT_H, borderTopWidth: 1 },
  slotHour: { borderTopColor: colors.borderDefault },
  slotHalf: { borderTopColor: colors.borderSubtle },
  // The quarter rules are dotted so the hours and halves still read first.
  slotQuarter: { borderTopColor: colors.borderSubtle, borderStyle: "dotted" as const },
  // Not selectable: a drag over a block's title would otherwise start selecting text.
  block: { position: "absolute" as const, paddingLeft: 2, userSelect: "none" } as Record<string, unknown>,
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
  struck: { textDecorationLine: "line-through" as const },
  grab: { cursor: "grab" } as Record<string, unknown>,
  // The bottom 5px of a movable block. Invisible: the ns-resize cursor is the affordance.
  resizeHandle: {
    position: "absolute" as const,
    left: 0,
    right: 0,
    bottom: 0,
    height: 5,
    zIndex: 2,
    cursor: "ns-resize",
  } as Record<string, unknown>,
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
