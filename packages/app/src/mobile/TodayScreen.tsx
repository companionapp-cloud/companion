import { useState } from "react";
import { StyleSheet, View } from "react-native";
import type { LinkRef } from "@companion/editor";
import { Button, colors, space } from "@companion/design-system";
import { DailyNote, TodayCalendar, todayISO } from "../TodayScreen";
import { Agenda } from "../CalendarAgenda";
import { useNav } from "../nav-context";
import { useCalendarItemSheet } from "./CalendarScreens";
import { NavAction, NavBar } from "./ui";

// Mobile web "Today" — a port of the native app's TodayScreen: the full-height daily-note
// editor with the month and the day's agenda tucked into a collapsible panel above it.
// The desktop shell puts the calendar in a side panel; no room for that on a phone, so it
// toggles from an action row instead, and picking a day hands the screen back to the note.
export function TodayScreen() {
  const nav = useNav();
  const [selected, setSelected] = useState(todayISO);
  const [today, setToday] = useState(todayISO);
  const [showCalendar, setShowCalendar] = useState(false);
  const { openItem, sheet } = useCalendarItemSheet();
  const isToday = selected === today;

  const onOpenRef = (ref: LinkRef) => {
    if (ref.type === "task" || ref.type === "note") nav.openInNewTab({ kind: ref.type, id: ref.id });
  };

  return (
    <View style={styles.root}>
      <NavBar title="Today" />
      <View style={styles.actions}>
        <View style={{ flex: 1 }} />
        {!isToday ? (
          <Button
            label="Today"
            variant="ghost"
            onPress={() => {
              setToday(todayISO());
              setSelected(todayISO());
            }}
          />
        ) : null}
        <NavAction icon="calendar" label={showCalendar ? "Hide calendar" : "Show calendar"} active={showCalendar} onPress={() => setShowCalendar((v) => !v)} />
      </View>
      {showCalendar ? (
        <View style={styles.calCard}>
          <TodayCalendar
            selected={selected}
            today={today}
            onSelect={(date) => {
              setSelected(date);
              // Collapse to hand the screen back to the note once a day is picked.
              setShowCalendar(false);
            }}
          />
          <View style={styles.agenda}>
            <Agenda date={selected} onOpenItem={openItem} />
          </View>
        </View>
      ) : null}
      <View style={styles.note}>
        <DailyNote key={selected} date={selected} onOpenRef={onOpenRef} headingPadding={20} />
      </View>
      {sheet}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceCard },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  calCard: {
    padding: space.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.surfaceCard,
  },
  agenda: { marginTop: space.lg, paddingTop: space.lg, borderTopWidth: 1, borderTopColor: colors.borderSubtle },
  note: { flex: 1, minHeight: 0 },
});
