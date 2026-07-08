import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Icon, IconButton, Text, colors, radius, shadow, space, type PressState } from "@companion/design-system";
import { useNav } from "./nav-context";
import { useNotifications } from "./NotificationsProvider";
import { NotificationRow } from "./NotificationRow";

const RECENT_COUNT = 8;

/** The toolbar bell (PLAN §6.4): an unread-count pill and a popover of the most recent
 *  feed entries. Pressing an entry marks it read and opens its task; "See all" goes to the
 *  notifications page. Same scrim-popover pattern as ListFilterMenu. */
export function NotificationsBell() {
  const nav = useNav();
  const { items, unreadCount, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const recent = items.slice(0, RECENT_COUNT);

  const openItem = (taskId: string, fireAt: string, read: boolean) => {
    if (!read) void markRead(taskId, fireAt);
    setOpen(false);
    nav.openTask(taskId);
  };

  return (
    <View style={styles.root}>
      <IconButton label="Notifications" onPress={() => setOpen((o) => !o)}>
        <Icon name="bell" color={open ? colors.accentHover : colors.textSecondary} />
      </IconButton>
      {unreadCount > 0 ? (
        <View style={styles.pill} pointerEvents="none">
          <Text style={styles.pillLabel}>{unreadCount > 9 ? "9+" : String(unreadCount)}</Text>
        </View>
      ) : null}

      {open ? (
        <>
          {/* Full-bleed scrim closes the popover on an outside tap. */}
          <Pressable style={styles.scrim} onPress={() => setOpen(false)} aria-label="Close notifications" />
          <View style={styles.menu}>
            <View style={styles.header}>
              <Text variant="caption" tone="secondary" style={{ fontWeight: "600", flex: 1 }}>
                Notifications
              </Text>
              {unreadCount > 0 ? (
                <Pressable
                  onPress={() => void markAllRead()}
                  aria-label="Mark all read"
                  style={({ hovered }: PressState) => [styles.headerAction, hovered ? styles.headerActionHover : null]}
                >
                  <Text variant="caption" tone="accent">
                    Mark all read
                  </Text>
                </Pressable>
              ) : null}
            </View>

            {recent.length === 0 ? (
              <View style={styles.empty}>
                <Icon name="bell" size={20} color={colors.textTertiary} />
                <Text variant="caption" tone="tertiary" style={{ marginTop: space.sm }}>
                  Nothing yet — task reminders land here.
                </Text>
              </View>
            ) : (
              <ScrollView style={{ maxHeight: 360 }}>
                {recent.map((n) => (
                  <NotificationRow key={`${n.taskId}:${n.fireAt}`} item={n} onPress={() => openItem(n.taskId, n.fireAt, n.read)} />
                ))}
              </ScrollView>
            )}

            <Pressable
              onPress={() => {
                setOpen(false);
                nav.goView("notifications");
              }}
              aria-label="See all notifications"
              style={({ hovered }: PressState) => [styles.footer, hovered ? styles.headerActionHover : null]}
            >
              <Text variant="caption" tone="secondary">
                See all notifications
              </Text>
            </Pressable>
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = {
  root: { position: "relative" as const, zIndex: 30 },
  pill: {
    position: "absolute" as const,
    top: -3,
    right: -5,
    minWidth: 15,
    height: 15,
    paddingHorizontal: 3,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  pillLabel: { color: colors.onAccent, fontSize: 9, lineHeight: 11, fontWeight: "700" as const },
  scrim: { position: "absolute" as const, top: 0, left: 0, width: 4000, height: 4000, marginLeft: -2000, marginTop: -2000 },
  menu: {
    position: "absolute" as const,
    top: 36,
    right: 0,
    width: 340,
    backgroundColor: colors.surfaceCard,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.md,
    paddingVertical: space.xs,
    zIndex: 40,
    ...shadow.md,
  },
  header: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    paddingHorizontal: space.md,
    paddingBottom: space.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  headerAction: { paddingHorizontal: space.xs, paddingVertical: 2, borderRadius: radius.sm },
  headerActionHover: { backgroundColor: colors.surfaceHover },
  empty: { alignItems: "center" as const, paddingVertical: space.xl },
  footer: {
    alignItems: "center" as const,
    paddingVertical: space.sm,
    marginTop: space.xs,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
  },
};
