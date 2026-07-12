import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { LinkRef } from "@companion/editor";
import { Icon, IconButton, Text, colors, font, space } from "@companion/design-system";
import { DailyNote, TodayCalendar, todayISO } from "../TodayScreen";
import { Agenda } from "../CalendarAgenda";
import { useNav } from "../nav-context";
import { useCalendarItemSheet } from "./CalendarScreens";

// Mobile web "Today" — a port of the native app's TodayScreen: the full-height daily-note
// editor with the mini calendar tucked into a collapsible panel above it. The desktop
// shell puts the calendar in a side panel; no room for that on a phone, so it toggles
// from an inline action row instead.
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
      <View style={styles.actions}>
        <View style={{ flex: 1 }} />
        {!isToday ? (
          <Pressable
            onPress={() => {
              setToday(todayISO());
              setSelected(todayISO());
            }}
            style={styles.resetBtn}
            aria-label="Jump to today"
          >
            <Text variant="label" style={{ color: colors.accent, fontWeight: font.weight.semibold }}>
              Today
            </Text>
          </Pressable>
        ) : null}
        <IconButton
          label={showCalendar ? "Hide calendar" : "Show calendar"}
          size="sm"
          active={showCalendar}
          onPress={() => setShowCalendar((v) => !v)}
        >
          <Icon name="calendar" size={18} color={showCalendar ? colors.accent : colors.textSecondary} />
        </IconButton>
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
    paddingTop: space.sm,
  },
  resetBtn: { minHeight: 36, paddingHorizontal: space.sm, justifyContent: "center" },
  calCard: {
    padding: space.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.surfaceCard,
  },
  agenda: { marginTop: space.lg, paddingTop: space.lg, borderTopWidth: 1, borderTopColor: colors.borderSubtle },
  note: { flex: 1 },
});
