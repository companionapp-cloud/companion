import { ScrollView, View, type StyleProp, type ViewStyle } from "react-native";
import type { CalendarItem, CalendarItemKind } from "@companion/core-bridge";
import { Icon, Text, colors, radius, space } from "@companion/design-system";

// Per-kind accent + label, shared with the agenda dot palette (PLAN §6.7).
const KIND_META: Record<CalendarItemKind, { color: string; label: string }> = {
  event: { color: colors.gray500, label: "Event" },
  task: { color: colors.info, label: "Task" },
  note: { color: colors.success, label: "Note" },
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** '9:00 AM', local 12-hour. */
function clockLabel(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h < 12 ? "AM" : "PM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

/** A human date + time range for an item: "Fri, Jul 10 · 9:00 AM – 10:00 AM" (or "All day"). */
export function formatWhen(item: CalendarItem): string {
  // All-day items carry a date-only marker at midnight UTC; read the date parts directly so
  // the weekday doesn't shift a day in negative-offset timezones. Timed items use the instant.
  if (item.allDay) {
    const [y, m, d] = item.startsAt.slice(0, 10).split("-").map(Number);
    const day = new Date(y, m - 1, d);
    return `${WEEKDAYS[day.getDay()]}, ${MONTHS_SHORT[day.getMonth()]} ${day.getDate()} · All day`;
  }
  const start = new Date(item.startsAt);
  const date = `${WEEKDAYS[start.getDay()]}, ${MONTHS_SHORT[start.getMonth()]} ${start.getDate()}`;
  const end = item.endsAt ? new Date(item.endsAt) : null;
  const time = end ? `${clockLabel(start)} – ${clockLabel(end)}` : clockLabel(start);
  return `${date} · ${time}`;
}

/** A compact detail card for a calendar item: kind, title, when, and (for events) location and
 *  description. Shared by the desktop hover popover and the mobile event detail screen so both
 *  surfaces show identical information. */
export function CalendarItemInfo({
  item,
  style,
  maxHeight,
}: {
  item: CalendarItem;
  style?: StyleProp<ViewStyle>;
  /** When set (the desktop hover popover), the body caps at this height and scrolls instead
   *  of truncating. Omitted when embedded in a screen that scrolls on its own (mobile). */
  maxHeight?: number;
}) {
  const meta = KIND_META[item.kind];
  const body = (
    <>
      <View style={styles.kindRow}>
        <View style={[styles.dot, { backgroundColor: item.color ?? meta.color }]} />
        <Text variant="mono" tone="tertiary" style={styles.kindLabel}>
          {meta.label}
        </Text>
      </View>
      <Text style={styles.title}>{item.title || "Untitled"}</Text>
      <Text variant="mono" tone="secondary" style={styles.when}>
        {formatWhen(item)}
      </Text>
      {item.location ? (
        <View style={styles.metaRow}>
          <Icon name="calendar" size={13} color={colors.textTertiary} />
          <Text tone="secondary" style={styles.metaText}>
            {item.location}
          </Text>
        </View>
      ) : null}
      {item.description ? (
        <Text tone="secondary" style={styles.description}>
          {item.description.trim()}
        </Text>
      ) : null}
    </>
  );
  return (
    <View style={[styles.card, style]}>
      {maxHeight != null ? (
        <ScrollView style={{ maxHeight }} contentContainerStyle={styles.body} showsVerticalScrollIndicator>
          {body}
        </ScrollView>
      ) : (
        <View style={styles.body}>{body}</View>
      )}
    </View>
  );
}

const styles = {
  card: {
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: space.lg,
    // A subtle lift for the floating popover; harmless when embedded in a screen.
    boxShadow: "0 6px 24px rgba(0,0,0,0.14)",
  },
  body: { gap: space.xs },
  kindRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.xs, marginBottom: 2 },
  dot: { width: 8, height: 8, borderRadius: radius.full },
  kindLabel: { fontSize: 10, textTransform: "uppercase" as const, letterSpacing: 0.6 },
  title: { fontSize: 14, fontWeight: "600" as const, color: colors.textPrimary },
  when: { fontSize: 12 },
  metaRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.xs, marginTop: 2 },
  metaText: { flex: 1, fontSize: 12 },
  description: { fontSize: 12, marginTop: space.xs, lineHeight: 17 },
};
