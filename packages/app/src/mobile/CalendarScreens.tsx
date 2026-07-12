import { useState, type ReactNode } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { CalendarItem } from "@companion/core-bridge";
import { Icon, IconButton, Text, colors, space } from "@companion/design-system";
import { TodayCalendar, todayISO, formatFullDate } from "../TodayScreen";
import { Agenda } from "../CalendarAgenda";
import { CalendarItemInfo } from "../CalendarItemInfo";
import { useCalendar } from "../CalendarProvider";
import { useNav } from "../nav-context";

// Mobile web Calendar (PLAN §6.7) — a port of the native app's CalendarScreen. The
// 7-column week grid the desktop shows is too cramped on a phone, so this is a stacked
// day view: a month picker to choose a day, then that day's agenda (merged feed events,
// due tasks, dated notes).

/** Routes an agenda item tap: tasks and notes push their editors; a feed event has no
 *  local entity, so it opens as a read-only bottom sheet (the native app pushes a detail
 *  screen, but the item isn't URL-serializable, so on web it stays an overlay). */
export function useCalendarItemSheet(): { openItem: (item: CalendarItem) => void; sheet: ReactNode } {
  const nav = useNav();
  const [item, setItem] = useState<CalendarItem | null>(null);
  const openItem = (it: CalendarItem) => {
    if (it.kind === "task" || it.kind === "note") nav.openInNewTab({ kind: it.kind, id: it.sourceId });
    else setItem(it);
  };
  const sheet = item ? (
    <Modal visible transparent animationType="slide" onRequestClose={() => setItem(null)}>
      <Pressable style={styles.scrim} onPress={() => setItem(null)} />
      <View style={styles.sheet}>
        <View style={styles.grabber} />
        <CalendarItemInfo item={item} />
      </View>
    </Modal>
  ) : null;
  return { openItem, sheet };
}

export function CalendarScreen() {
  const { refresh } = useCalendar();
  const [selected, setSelected] = useState(todayISO);
  const [refreshing, setRefreshing] = useState(false);
  const { openItem, sheet } = useCalendarItemSheet();
  const today = todayISO();

  // An inline refresh action re-fetches the ICS feeds now (PLAN §6.7).
  const onRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.actions}>
        <View style={{ flex: 1 }} />
        <IconButton label="Refresh calendars" size="sm" onPress={() => void onRefresh()} disabled={refreshing}>
          {refreshing ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : (
            <Icon name="refresh" size={18} color={colors.textSecondary} />
          )}
        </IconButton>
      </View>
      <View style={styles.calCard}>
        <TodayCalendar selected={selected} today={today} onSelect={setSelected} allowFuture />
      </View>
      <Text variant="mono" tone="tertiary" style={styles.dateLabel}>
        {formatFullDate(selected)}
      </Text>
      <Agenda date={selected} onOpenItem={openItem} />
      {sheet}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceCard },
  content: { padding: space.lg, paddingBottom: space.xxl },
  actions: { flexDirection: "row", alignItems: "center" },
  calCard: {
    paddingBottom: space.lg,
    marginBottom: space.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  dateLabel: { marginBottom: space.md, fontSize: 12 },
  scrim: { flex: 1, backgroundColor: "rgba(17,17,16,0.35)" },
  sheet: {
    backgroundColor: colors.surfaceCard,
    borderTopLeftRadius: space.xl,
    borderTopRightRadius: space.xl,
    padding: space.xl,
  },
  grabber: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderDefault, alignSelf: "center", marginBottom: space.lg },
});
