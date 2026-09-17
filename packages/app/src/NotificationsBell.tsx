import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Badge, Button, Icon, IconButton, Text, colors, icon, layout, radius, shadow, space } from "@companion/design-system";
import { useNav } from "./nav-context";
import { useNotifications } from "./NotificationsProvider";
import { NotificationRow } from "./NotificationRow";

const RECENT_COUNT = 8;

/** The toolbar bell (PLAN §6.4): a round danger unread count and a popover of the most recent
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
      <IconButton label="Notifications" size="sm" active={open} onPress={() => setOpen((o) => !o)}>
        <Icon name="bell" size={icon.md} color={open ? colors.textAccent : colors.textSecondary} />
      </IconButton>
      {unreadCount > 0 ? <Badge label={unreadCount > 9 ? "9+" : String(unreadCount)} tone="danger" round /> : null}

      {open ? (
        <>
          {/* Full-bleed scrim closes the popover on an outside tap. */}
          <Pressable style={styles.scrim} onPress={() => setOpen(false)} aria-label="Close notifications" />
          <View style={styles.menu}>
            <View style={styles.header}>
              <Text variant="eyebrow" tone="quaternary" style={{ flex: 1 }}>
                Notifications{unreadCount > 0 ? ` · ${unreadCount}` : ""}
              </Text>
              {unreadCount > 0 ? <Button label="Mark all read" size="sm" variant="ghost" onPress={() => void markAllRead()} /> : null}
            </View>

            {recent.length === 0 ? (
              <View style={styles.empty}>
                <Icon name="bell" size={icon.tile} color={colors.textQuaternary} />
                <Text variant="caption" tone="tertiary">
                  Nothing yet — task reminders land here.
                </Text>
              </View>
            ) : (
              <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={styles.list}>
                {recent.map((n) => (
                  <NotificationRow key={`${n.taskId}:${n.fireAt}`} item={n} onPress={() => openItem(n.taskId, n.fireAt, n.read)} />
                ))}
              </ScrollView>
            )}

            <View style={styles.footer}>
              <Button
                label="See all notifications"
                size="sm"
                variant="ghost"
                fullWidth
                onPress={() => {
                  setOpen(false);
                  nav.goView("notifications");
                }}
              />
            </View>
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = {
  root: { position: "relative" as const, flexDirection: "row" as const, alignItems: "center" as const, gap: space.xxs, zIndex: 30 },
  scrim: { position: "absolute" as const, top: 0, left: 0, width: 4000, height: 4000, marginLeft: -2000, marginTop: -2000 },
  menu: {
    position: "absolute" as const,
    top: layout.subToolbarH,
    right: 0,
    width: 300,
    backgroundColor: colors.surfaceOverlay,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.lg,
    overflow: "hidden" as const,
    zIndex: 40,
    ...shadow.md,
  },
  header: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    height: layout.subToolbarH,
    paddingLeft: space.ml,
    paddingRight: space.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  list: { padding: space.xs, gap: 1 },
  empty: { alignItems: "center" as const, gap: space.md, paddingVertical: space.xxl, paddingHorizontal: space.xl },
  footer: { padding: space.xs, borderTopWidth: 1, borderTopColor: colors.borderSubtle },
};
