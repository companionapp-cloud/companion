import { ScrollView, View } from "react-native";
import type { NotificationFeedItem } from "@companion/core-bridge";
import { Button, Icon, Spinner, Text, colors, layout, radius, space } from "@companion/design-system";
import { useNotifications } from "./NotificationsProvider";
import { NotificationRow } from "./NotificationRow";

/** The notifications page (PLAN §6.4): the full feed, grouped Today / Earlier, with
 *  mark-all-read. Self-contained apart from `onOpenTask` (the host decides how a task
 *  opens) so both the desktop shell and the mobile stack can host it. */
export function NotificationsScreen({ onOpenTask }: { onOpenTask: (taskId: string) => void }) {
  const { items, unreadCount, loading, markRead, markAllRead } = useNotifications();

  if (loading) return <Spinner label="Checking for notifications…" />;

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const today = items.filter((n) => new Date(n.fireAt) >= startOfToday);
  const earlier = items.filter((n) => new Date(n.fireAt) < startOfToday);

  const open = (n: NotificationFeedItem) => {
    if (!n.read) void markRead(n.taskId, n.fireAt);
    onOpenTask(n.taskId);
  };

  const group = (label: string, entries: NotificationFeedItem[]) =>
    entries.length === 0 ? null : (
      <View key={label} style={{ gap: space.sm }}>
        <Text variant="caption" tone="tertiary" style={styles.groupLabel}>
          {label}
        </Text>
        <View style={styles.card}>
          {entries.map((n, i) => (
            <View key={`${n.taskId}:${n.fireAt}`} style={i === entries.length - 1 ? null : styles.rowDivider}>
              <NotificationRow item={n} onPress={() => open(n)} />
            </View>
          ))}
        </View>
      </View>
    );

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.titleRow}>
        <Text variant="title" style={{ flex: 1 }}>
          Notifications
        </Text>
        {unreadCount > 0 ? <Button label="Mark all read" size="sm" variant="secondary" onPress={() => void markAllRead()} /> : null}
      </View>
      <Text tone="tertiary" variant="caption" style={styles.blurb}>
        Task reminders and due alerts from the last two weeks. Read state follows you across devices.
      </Text>

      {items.length === 0 ? (
        <View style={styles.empty}>
          <Icon name="bell" size={28} color={colors.textTertiary} />
          <Text tone="tertiary" style={{ marginTop: space.md }}>
            Nothing yet — set a reminder or due date on a task and it will land here.
          </Text>
        </View>
      ) : (
        <View style={{ gap: space.lg }}>
          {group("Today", today)}
          {group("Earlier", earlier)}
        </View>
      )}
    </ScrollView>
  );
}

const styles = {
  page: { maxWidth: layout.contentMax, width: "100%" as const, marginHorizontal: "auto" as const, padding: space.xxl, gap: space.md },
  titleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.md },
  blurb: { lineHeight: 18, marginBottom: space.md },
  groupLabel: { fontWeight: "600" as const, textTransform: "uppercase" as const, letterSpacing: 0.4 },
  empty: { alignItems: "center" as const, paddingVertical: space.xxxl },
  card: {
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    overflow: "hidden" as const,
  },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
};
