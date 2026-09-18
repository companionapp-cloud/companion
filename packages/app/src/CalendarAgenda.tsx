import { useEffect, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import type { CalendarItem, CalendarItemKind } from "@companion/core-bridge";
import {
  Icon,
  Text,
  colors,
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

/** The local calendar day ('YYYY-MM-DD') an item falls on. All-day items (dated notes,
 *  all-day events) carry a date-only marker stored as midnight UTC; converting that instant
 *  to local time would shift it a day in some zones, so their date portion is used directly.
 *  Timed items use their instant in the user's timezone. */
export function itemDay(item: CalendarItem): string {
  if (item.allDay) return item.startsAt.slice(0, 10);
  const d = new Date(item.startsAt);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Per-kind accent for the touch agenda dot (PLAN §6.7). Events lean neutral, tasks read blue,
// dated notes read green — one glance tells you what a line is.
const KIND_COLOR: Record<CalendarItemKind, string> = {
  event: colors.textTertiary,
  task: colors.info,
  note: colors.success,
};
// The pointer agenda swaps the dot for a quiet 12px glyph: the shape says what a line is, and
// colour is left for a feed's own swatch.
const KIND_ICON: Record<CalendarItemKind, IconName> = {
  event: "calendar",
  task: "tasks",
  note: "notes",
};

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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
  if (item.allDay) return "all day";
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
}: {
  date: string;
  onOpenItem?: (item: CalendarItem) => void;
}) {
  const { range, revision } = useCalendar();
  const [items, setItems] = useState<CalendarItem[] | null>(null);
  const touch = useDensity() === "touch";

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

  const timeWidth = touch ? TIME_W_TOUCH : (items ?? []).some((it) => it.allDay) ? TIME_W_ALL_DAY : TIME_W;

  return (
    <View>
      <Text variant="eyebrow" tone="quaternary" style={styles.header}>
        Agenda · {shortDate(date)}
      </Text>
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

/** One agenda line: time · kind · title. Hovering highlights the row and reveals an event's
 *  location inline (web only — native has no hover, it taps through to a subview). Tapping
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
  const [hovered, setHovered] = useState(false);
  // Tasks/notes open everywhere. Feed events open to a detail subview on native, but on web
  // they aren't linkable (no local entity) — the hover reveal shows their detail instead.
  const openable = !!onOpenItem && (item.kind !== "event" || Platform.OS !== "web");
  const gap = touch ? space.ml : space.md;
  const markW = touch ? 7 : icon.sm;
  return (
    <Pressable
      disabled={!openable}
      onPress={() => onOpenItem?.(item)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }: PressState) => [
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
      {hovered && item.location ? (
        // Indented to line up under the title (past the time column + kind mark + gaps).
        <Text tone="tertiary" variant="caption" style={{ marginLeft: timeWidth + gap + markW + gap, paddingBottom: 3 }} numberOfLines={1}>
          {item.location}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = {
  header: { paddingHorizontal: space.sm, paddingTop: space.md, paddingBottom: 3 },
  empty: { paddingHorizontal: space.sm, paddingVertical: space.md },
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
