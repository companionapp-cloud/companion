import { Pressable, View } from "react-native";
import type { NotificationFeedItem } from "@companion/core-bridge";
import { Icon, Text, colors, font, icon, motion, radius, row, space, transition, useDensity, type PressState } from "@companion/design-system";

/** One feed entry, shared by the bell popover and the notifications page (PLAN §6.4):
 *  kind icon, title + body, mono relative time, and an unread dot. A two-line 38px row with
 *  a pointer, 60px on touch. Settled tasks render muted — the notification already served
 *  its purpose. */
export function NotificationRow({ item, onPress }: { item: NotificationFeedItem; onPress: () => void }) {
  const muted = item.settled;
  const touch = useDensity() === "touch";
  return (
    <Pressable
      onPress={onPress}
      aria-label={`Open ${item.title}`}
      style={({ hovered, pressed }: PressState) => [
        styles.row,
        transition("background-color", motion.fast),
        { minHeight: touch ? 60 : row.twoLine, paddingHorizontal: touch ? space.lg : space.sm, gap: touch ? space.lg : space.sm },
        pressed ? styles.rowPressed : hovered ? styles.rowHover : null,
      ]}
    >
      <Icon name={item.kind === "reminder" ? "bell" : "calendar"} size={touch ? icon.tile : icon.sm} color={touch ? colors.textTertiary : colors.textQuaternary} />
      <View style={styles.body}>
        <Text variant="label" numberOfLines={1} tone={muted ? "tertiary" : "default"} style={item.read ? null : styles.unreadTitle}>
          {item.title}
        </Text>
        <Text variant="caption" tone="tertiary" numberOfLines={1}>
          {item.body}
        </Text>
      </View>
      <Text variant="mono" tone="quaternary" numberOfLines={1}>
        {timeAgo(item.fireAt)}
        {muted ? " · completed" : ""}
      </Text>
      {/* The dot keeps its slot when read so the timestamps stay in one column. */}
      <View style={[styles.dot, item.read ? styles.dotRead : null]} aria-label={item.read ? undefined : "Unread"} />
    </Pressable>
  );
}

/** Compact "how long ago" for a fire instant. */
export function timeAgo(fireAt: string): string {
  const ms = Date.now() - new Date(fireAt).getTime();
  if (Number.isNaN(ms) || ms < 0) return "now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

const styles = {
  row: { flexDirection: "row" as const, alignItems: "center" as const, borderRadius: radius.sm },
  rowHover: { backgroundColor: colors.surfaceHover },
  rowPressed: { backgroundColor: colors.surfaceActive },
  body: { flex: 1, minWidth: 0 },
  unreadTitle: { fontWeight: font.weight.semibold },
  dot: { width: 5, height: 5, borderRadius: radius.full, backgroundColor: colors.accent, flexShrink: 0 },
  dotRead: { backgroundColor: "transparent" as const },
};
