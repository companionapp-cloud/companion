import { ScrollView, View, type StyleProp, type ViewStyle } from "react-native";
import type { CalendarItem, CalendarItemKind } from "@companion/core-bridge";
import { Icon, Text, colors, font, icon, radius, shadow, space, useDensity } from "@companion/design-system";

// Per-kind accent + label, shared with the agenda palette (PLAN §6.7). The label is mono
// metadata, so it stays lowercase.
const KIND_META: Record<CalendarItemKind, { color: string; label: string }> = {
  event: { color: colors.textTertiary, label: "event" },
  task: { color: colors.info, label: "task" },
  note: { color: colors.success, label: "note" },
  project: { color: colors.accent, label: "project" },
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
  // A span runs from its start to its deadline: "Thu, Oct 1 – Fri, Oct 9".
  if (item.span && item.endsAt) {
    const due = new Date(item.endsAt);
    return `${date} – ${WEEKDAYS[due.getDay()]}, ${MONTHS_SHORT[due.getMonth()]} ${due.getDate()}`;
  }
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
  /** When set (the desktop hover popover), the card floats: it caps at this height and scrolls
   *  instead of truncating, and takes the popover shadow. Omitted when embedded in a screen
   *  that scrolls on its own (mobile) — there it is a flat, hairlined panel. */
  maxHeight?: number;
}) {
  const touch = useDensity() === "touch";
  const meta = KIND_META[item.kind];
  const floating = maxHeight != null;
  const body = (
    <>
      <View style={styles.kindRow}>
        <View style={[styles.dot, { backgroundColor: item.color ?? meta.color }]} />
        <Text variant="mono" tone="tertiary">
          {meta.label}
        </Text>
      </View>
      <Text variant={touch ? "title" : "label"}>{item.title || "Untitled"}</Text>
      <Text variant="mono" tone="secondary">
        {formatWhen(item)}
      </Text>
      {item.location ? (
        <View style={styles.metaRow}>
          <Icon name="calendar" size={icon.sm} color={colors.textQuaternary} />
          <Text variant="caption" tone="secondary" style={styles.metaText}>
            {item.location}
          </Text>
        </View>
      ) : null}
      {item.description ? (
        <Text variant="caption" tone="secondary" style={styles.description}>
          {item.description.trim()}
        </Text>
      ) : null}
    </>
  );
  return (
    <View style={[styles.card, touch ? styles.cardTouch : null, floating ? styles.cardFloating : null, style]}>
      {floating ? (
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
    backgroundColor: colors.surfaceOverlay,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: space.md,
  },
  // Touch surfaces embed the card in a screen or sheet: prose-scale padding, same hairline.
  cardTouch: { padding: space.lg },
  // Only the hover popover floats above the document, so only it earns a shadow.
  cardFloating: shadow.md,
  body: { gap: 3 },
  kindRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 5 },
  dot: { width: 7, height: 7, borderRadius: radius.sm },
  metaRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 5, marginTop: 2 },
  metaText: { flex: 1 },
  description: { marginTop: 2, fontSize: font.size.sm, lineHeight: 17 },
};
