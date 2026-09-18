import { useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import type { CalendarItem } from "@companion/core-bridge";
import { Spinner, Text, colors, control, radius, space } from "@companion/design-system";
import { TodayCalendar, todayISO, formatFullDate } from "../TodayScreen";
import { Agenda, itemDay } from "../CalendarAgenda";
import { CalendarItemInfo } from "../CalendarItemInfo";
import { useCalendar } from "../CalendarProvider";
import { useNav } from "../nav-context";
import { BottomSheet, NavAction, NavBar } from "./ui";

// Mobile web Calendar (PLAN §6.7) — a port of the native app's CalendarScreen. The
// 7-column week grid the desktop shows is too cramped on a phone, so this is a stacked
// day view: a month card to choose a day, a mono date label, then that day's agenda
// (merged feed events, due tasks, dated notes). Resync is an icon in the nav bar.

/** Routes an agenda item tap: tasks push their editor, a dated note opens Today on its day
 *  (it's a daily note, not a browse-list note); a feed event has no
 *  local entity, so it opens as a read-only bottom sheet (the native app pushes a detail
 *  screen, but the item isn't URL-serializable, so on web it stays an overlay). */
export function useCalendarItemSheet(): { openItem: (item: CalendarItem) => void; sheet: ReactNode } {
  const nav = useNav();
  const [item, setItem] = useState<CalendarItem | null>(null);
  const openItem = (it: CalendarItem) => {
    if (it.kind === "task") nav.openInNewTab({ kind: "task", id: it.sourceId });
    else if (it.kind === "note") nav.openInNewTab({ kind: "view", view: "today", date: itemDay(it) });
    else setItem(it);
  };
  const sheet = item ? (
    <BottomSheet onClose={() => setItem(null)}>
      <CalendarItemInfo item={item} />
    </BottomSheet>
  ) : null;
  return { openItem, sheet };
}

export function CalendarScreen() {
  const { refresh } = useCalendar();
  const [selected, setSelected] = useState(todayISO);
  const [refreshing, setRefreshing] = useState(false);
  const { openItem, sheet } = useCalendarItemSheet();
  const today = todayISO();

  // The bar's refresh action re-fetches the ICS feeds now (PLAN §6.7).
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
    <View style={styles.root}>
      <NavBar
        title="Calendar"
        right={
          refreshing ? (
            <View style={styles.syncing}>
              <Spinner inline size={14} />
            </View>
          ) : (
            <NavAction icon="refresh" label="Refresh calendars" onPress={() => void onRefresh()} />
          )
        }
      />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.calCard}>
          <TodayCalendar selected={selected} today={today} onSelect={setSelected} allowFuture />
        </View>
        <Text variant="mono" tone="tertiary" style={styles.dateLabel}>
          {formatFullDate(selected)}
        </Text>
        <View style={styles.agenda}>
          <Agenda date={selected} onOpenItem={openItem} />
        </View>
      </ScrollView>
      {sheet}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
  content: { padding: space.ml, paddingBottom: space.xxl },
  // Holds the refresh button's box while the spinner stands in for it.
  syncing: { width: control.lg, height: control.lg, alignItems: "center", justifyContent: "center" },
  calCard: {
    padding: space.lg,
    backgroundColor: colors.surfaceCard,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.lg,
  },
  dateLabel: { paddingHorizontal: space.sm, paddingTop: space.lg, paddingBottom: space.sm },
  agenda: { paddingHorizontal: space.sm },
});
