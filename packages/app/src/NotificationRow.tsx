import { Pressable, View } from "react-native";
import type { NotificationFeedItem } from "@companion/core-bridge";
import { Icon, Text, colors, space, type PressState } from "@companion/design-system";

/** One feed entry, shared by the bell popover and the notifications page (PLAN §6.4):
 *  kind icon, title + body, relative time, and an unread dot. Settled tasks render muted —
 *  the notification already served its purpose. */
export function NotificationRow({ item, onPress }: { item: NotificationFeedItem; onPress: () => void }) {
  const muted = item.settled;
  return (
    <Pressable
      onPress={onPress}
      aria-label={`Open ${item.title}`}
      style={({ hovered }: PressState) => [styles.row, hovered ? styles.rowHover : null]}
    >
      <Icon name={item.kind === "reminder" ? "bell" : "calendar"} size={16} color={colors.textTertiary} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} tone={muted ? "tertiary" : "default"} style={item.read ? null : styles.unreadTitle}>
          {item.title}
        </Text>
        <Text variant="caption" tone="tertiary" numberOfLines={1}>
          {item.body} · {timeAgo(item.fireAt)}
          {muted ? " · completed" : ""}
        </Text>
      </View>
      {item.read ? null : <View style={styles.dot} aria-label="Unread" />}
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
  row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  rowHover: { backgroundColor: colors.surfaceHover },
  unreadTitle: { fontWeight: "600" as const },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent, flexShrink: 0 },
};
