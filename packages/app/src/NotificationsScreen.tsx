import { ScrollView, View } from "react-native";
import type { NotificationFeedItem } from "@companion/core-bridge";
import { Button, Icon, Spinner, Text, colors, icon, layout, radius, space, useDensity } from "@companion/design-system";
import { useNotifications } from "./NotificationsProvider";
import { NotificationRow } from "./NotificationRow";

/** The notifications page (PLAN §6.4): the full feed, grouped Today / Earlier, with
 *  mark-all-read. Self-contained apart from `onOpenTask` (the host decides how a task
 *  opens) so both the desktop shell and the mobile stack can host it. */
export function NotificationsScreen({
  onOpenTask,
  markAllAction,
}: {
  onOpenTask: (taskId: string) => void;
  /** Render the in-page “Mark all read” action. Defaults to on with a pointer and off under
   *  touch density, where the mobile nav bars carry the action (and the title) themselves. */
  markAllAction?: boolean;
}) {
  const touch = useDensity() === "touch";
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

  // Pointer: eyebrow + dense rows. Touch: the same rows (60px there) in one grouped card.
  const group = (label: string, entries: NotificationFeedItem[]) =>
    entries.length === 0 ? null : (
      <View key={label} style={styles.group}>
        <Text variant="eyebrow" tone="quaternary" style={styles.groupLabel}>
          {label} · {entries.length}
        </Text>
        <View style={touch ? styles.card : styles.rows}>
          {entries.map((n, i) => (
            <View key={`${n.taskId}:${n.fireAt}`} style={touch && i !== entries.length - 1 ? styles.rowDivider : null}>
              <NotificationRow item={n} onPress={() => open(n)} />
            </View>
          ))}
        </View>
      </View>
    );

  const showMarkAll = (markAllAction ?? !touch) && unreadCount > 0;

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.page, touch ? styles.pageTouch : null]}>
      {touch ? (
        showMarkAll ? (
          <Button label="Mark all read" variant="secondary" fullWidth onPress={() => void markAllRead()} />
        ) : null
      ) : (
        <View style={styles.titleRow}>
          <Text variant="heading" style={{ flex: 1 }}>
            Notifications
          </Text>
          {showMarkAll ? <Button label="Mark all read" size="sm" variant="secondary" onPress={() => void markAllRead()} /> : null}
        </View>
      )}
      <Text tone="tertiary" variant="caption" style={styles.blurb}>
        Task reminders and due alerts from the last two weeks. Read state follows you across devices.
      </Text>

      {items.length === 0 ? (
        <View style={styles.empty}>
          <Icon name="bell" size={icon.tile} color={colors.textQuaternary} />
          <Text variant="caption" tone="tertiary" style={styles.emptyText}>
            Nothing yet — set a reminder or due date on a task and it will land here.
          </Text>
        </View>
      ) : (
        <View style={{ gap: space.xl }}>
          {group("Today", today)}
          {group("Earlier", earlier)}
        </View>
      )}
    </ScrollView>
  );
}

const styles = {
  page: {
    maxWidth: layout.contentMax,
    width: "100%" as const,
    marginHorizontal: "auto" as const,
    paddingVertical: space.xl2,
    paddingHorizontal: space.xxl,
    gap: space.md,
  },
  pageTouch: { padding: space.xl, gap: space.lg },
  titleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.md },
  blurb: { lineHeight: 18, marginBottom: space.md },
  group: { gap: space.sm },
  groupLabel: { paddingHorizontal: space.sm },
  rows: { gap: 1 },
  empty: { alignItems: "center" as const, gap: space.md, paddingVertical: space.huge },
  emptyText: { textAlign: "center" as const, maxWidth: 320, lineHeight: 18 },
  card: {
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    overflow: "hidden" as const,
  },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
};
