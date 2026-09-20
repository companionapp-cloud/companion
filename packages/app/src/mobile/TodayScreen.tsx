import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import type { LinkRef } from "@companion/editor";
import { Button, colors, space } from "@companion/design-system";
import { DailyNote, TodayCalendar, todayISO } from "../TodayScreen";
import { Agenda } from "../CalendarAgenda";
import { useNav } from "../nav-context";
import { useCalendarItemSheet } from "./CalendarScreens";
import { NavAction, NavBar } from "./ui";

const AGENDA_KEY = "companion.today.showAgenda";

/** Whether the agenda shows. Per-device, mirrored to localStorage (guarded: absent in some
 *  sandboxes); shown until the user hides it. */
function loadShowAgenda(): boolean {
  try {
    return globalThis.localStorage?.getItem(AGENDA_KEY) !== "false";
  } catch {
    return true;
  }
}

function saveShowAgenda(show: boolean) {
  try {
    globalThis.localStorage?.setItem(AGENDA_KEY, String(show));
  } catch {
    // Storage is best-effort.
  }
}

// Mobile web "Today" — a port of the native app's TodayScreen: the full-height daily-note
// editor with the month and the day's agenda in a panel above it. The desktop shell puts
// both in a side panel; no room for that on a phone, so each toggles from an action row
// instead. The agenda toggle is remembered; the month collapses once a day is picked.
export function TodayScreen() {
  const nav = useNav();
  // Opened on a specific day (a dated note from the calendar, or /today/<date>)? Seed the
  // selection with it and follow it if the route's date changes.
  const requestedDay = nav.current.kind === "view" ? nav.current.date : undefined;
  const [selected, setSelected] = useState(() => requestedDay ?? todayISO());
  useEffect(() => {
    if (requestedDay) setSelected(requestedDay);
  }, [requestedDay]);
  const [today, setToday] = useState(todayISO);
  const [showCalendar, setShowCalendar] = useState(false);
  const [showAgenda, setShowAgenda] = useState(loadShowAgenda);
  // Drawing on the day's note (PLAN-drawing.md).
  const [drawing, setDrawing] = useState(false);
  const { openItem, sheet } = useCalendarItemSheet();
  const isToday = selected === today;

  const toggleAgenda = () => {
    const next = !showAgenda;
    setShowAgenda(next);
    saveShowAgenda(next);
  };

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
        <NavAction icon="listBullet" label={showAgenda ? "Hide agenda" : "Show agenda"} active={showAgenda} onPress={toggleAgenda} />
        <NavAction icon="calendar" label={showCalendar ? "Hide calendar" : "Show calendar"} active={showCalendar} onPress={() => setShowCalendar((v) => !v)} />
        <NavAction icon="pen" label={drawing ? "Stop drawing" : "Draw on note"} active={drawing} onPress={() => setDrawing((v) => !v)} />
      </View>
      {showCalendar || showAgenda ? (
        // Capped and scrollable so a busy agenda can't push the note off the screen.
        <ScrollView style={styles.panel} contentContainerStyle={styles.panelContent}>
          {showCalendar ? (
            <TodayCalendar
              selected={selected}
              today={today}
              onSelect={(date) => {
                setSelected(date);
                // Collapse to hand the screen back to the note once a day is picked.
                setShowCalendar(false);
              }}
            />
          ) : null}
          {showAgenda ? (
            <View style={showCalendar ? styles.agendaBelowMonth : null}>
              <Agenda date={selected} onOpenItem={openItem} creatable />
            </View>
          ) : null}
        </ScrollView>
      ) : null}
      <View style={styles.note}>
        <DailyNote
          key={selected}
          date={selected}
          onOpenRef={onOpenRef}
          headingPadding={20}
          drawing={drawing}
          onDrawingChange={setDrawing}
        />
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
  panel: {
    flexGrow: 0,
    maxHeight: "62%",
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.surfaceCard,
  },
  panelContent: { padding: space.lg },
  agendaBelowMonth: { marginTop: space.lg, paddingTop: space.lg, borderTopWidth: 1, borderTopColor: colors.borderSubtle },
  note: { flex: 1, minHeight: 0 },
});
