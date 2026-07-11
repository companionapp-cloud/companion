import { useEffect, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import type { CalendarItem, CalendarItemKind } from "@companion/core-bridge";
import { Text, colors, radius, space } from "@companion/design-system";
import { useCalendar } from "./CalendarProvider";

// Per-kind accent for the agenda dot (PLAN §6.7). Events lean neutral, tasks read blue,
// dated notes read green — one glance tells you what a line is.
const KIND_COLOR: Record<CalendarItemKind, string> = {
  event: colors.gray500,
  task: colors.info,
  note: colors.success,
};

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

/** A single day's agenda: the merged items for `date`, one line each (time · kind dot ·
 *  title). Used on the Today view (desktop aside + mobile panel) and mobile Calendar. Rows
 *  are pressable so a note/task can open; feed events aren't openable. */
export function Agenda({
  date,
  onOpenItem,
}: {
  date: string;
  onOpenItem?: (item: CalendarItem) => void;
}) {
  const { range, revision } = useCalendar();
  const [items, setItems] = useState<CalendarItem[] | null>(null);

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

  return (
    <View>
      <View style={styles.header}>
        <Text variant="mono" tone="tertiary" style={styles.headerLabel}>
          Agenda
        </Text>
      </View>
      {items && items.length === 0 ? (
        <Text tone="tertiary" style={styles.empty}>
          Clear day. Enjoy the whitespace.
        </Text>
      ) : (
        <View>
          {(items ?? []).map((it) => (
            <AgendaRow key={it.id} item={it} onOpenItem={onOpenItem} />
          ))}
        </View>
      )}
    </View>
  );
}

/** One agenda line: time · kind dot · title. Hovering highlights the row and reveals an
 *  event's location inline (web only — native has no hover, it taps through to a subview).
 *  Tapping opens the item when the host wired `onOpenItem`. */
function AgendaRow({ item, onOpenItem }: { item: CalendarItem; onOpenItem?: (item: CalendarItem) => void }) {
  const [hovered, setHovered] = useState(false);
  // Tasks/notes open everywhere. Feed events open to a detail subview on native, but on web
  // they aren't linkable (no local entity) — the hover reveal shows their detail instead.
  const openable = !!onOpenItem && (item.kind !== "event" || Platform.OS !== "web");
  return (
    <Pressable
      disabled={!openable}
      onPress={() => onOpenItem?.(item)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[styles.row, hovered ? styles.rowHovered : null]}
    >
      <View style={styles.rowMain}>
        <Text variant="mono" tone="tertiary" style={styles.time} numberOfLines={1}>
          {timeLabel(item)}
        </Text>
        <View style={[styles.dot, { backgroundColor: item.color ?? KIND_COLOR[item.kind] }]} />
        <Text style={styles.title} numberOfLines={1}>
          {item.title || "Untitled"}
        </Text>
      </View>
      {hovered && item.location ? (
        <Text tone="tertiary" variant="caption" style={styles.detail} numberOfLines={1}>
          {item.location}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = {
  header: { flexDirection: "row" as const, alignItems: "baseline" as const, gap: space.sm, marginBottom: space.lg },
  headerLabel: { textTransform: "uppercase" as const, letterSpacing: 0.6, fontSize: 11 },
  empty: { paddingVertical: space.xxl, fontSize: 13 },
  row: {
    paddingVertical: 9,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
  },
  rowMain: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.lg },
  rowHovered: { backgroundColor: colors.surfaceHover },
  time: { width: 56, flexShrink: 0, fontSize: 12 },
  dot: { width: 7, height: 7, flexShrink: 0, borderRadius: radius.full },
  title: { flex: 1, minWidth: 0, fontSize: 13, color: colors.textPrimary },
  // Indented to line up under the title (past the time column + dot + gaps).
  detail: { marginTop: 2, marginLeft: 56 + space.lg + 7 + space.lg },
};
