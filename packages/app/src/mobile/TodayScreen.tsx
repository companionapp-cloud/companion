import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import type { LinkRef } from "@companion/editor";
import { Button, colors, space } from "@companion/design-system";
import { DailyNote, TodayCalendar, todayISO } from "../TodayScreen";
import { Agenda } from "../CalendarAgenda";
import { ListFilterTabs, type FilterOption } from "../ListFilterMenu";
import { useNav } from "../nav-context";
import { useCalendarItemSheet } from "./CalendarScreens";
import { NavAction, NavBar } from "./ui";
import { TourAnchor } from "../onboarding/anchors";
import { useTourView } from "../onboarding/OnboardingProvider";

type Segment = "note" | "agenda";

const SEGMENTS: FilterOption<Segment>[] = [
  { value: "note", label: "Note" },
  { value: "agenda", label: "Agenda" },
];

const SEGMENT_KEY = "companion.today.segment";

/** The segment Today last showed. Per-device, mirrored to localStorage (guarded: absent in some
 *  sandboxes); the note until the user picks the agenda. */
function loadSegment(): Segment {
  try {
    return globalThis.localStorage?.getItem(SEGMENT_KEY) === "agenda" ? "agenda" : "note";
  } catch {
    return "note";
  }
}

function saveSegment(segment: Segment) {
  try {
    globalThis.localStorage?.setItem(SEGMENT_KEY, segment);
  } catch {
    // Storage is best-effort.
  }
}

// Mobile web "Today", a port of the native app's TodayScreen. The desktop shell sets the month
// and the day's agenda in a side panel beside the daily note; a phone has no room for both, so
// they are two segments: the full-height note, and the month over the day's agenda. The last
// segment is remembered. Picking a day in the month keeps the agenda up for that day, and the
// note follows the same day.
export function TodayScreen() {
  const nav = useNav();
  // Opened on a specific day (a dated note from the calendar, or /today/<date>)? Seed the
  // selection with it, show its note, and follow it if the route's date changes.
  const requestedDay = nav.current.kind === "view" ? nav.current.date : undefined;
  const [selected, setSelected] = useState(() => requestedDay ?? todayISO());
  const [segment, setSegment] = useState<Segment>(() => (requestedDay ? "note" : loadSegment()));
  useEffect(() => {
    if (!requestedDay) return;
    setSelected(requestedDay);
    setSegment("note");
  }, [requestedDay]);
  const [today, setToday] = useState(todayISO);
  // Drawing on the day's note (PLAN-drawing.md).
  const [drawing, setDrawing] = useState(false);
  const { openItem, sheet } = useCalendarItemSheet();
  const isToday = selected === today;
  // A tutorial step can need one side of the page (TourStep.view); it shows over the user's own.
  const tourView = useTourView();
  const shown: Segment = tourView === "today.note" ? "note" : tourView === "today.agenda" ? "agenda" : segment;

  const choose = (next: Segment) => {
    setSegment(next);
    saveSegment(next);
    if (next !== "note") setDrawing(false);
  };

  const onOpenRef = (ref: LinkRef) => {
    if (ref.type === "task" || ref.type === "note") nav.openInNewTab({ kind: ref.type, id: ref.id });
  };

  return (
    <View style={styles.root}>
      <NavBar
        title="Today"
        right={
          shown === "note" ? (
            <NavAction icon="pen" label={drawing ? "Stop drawing" : "Draw on note"} active={drawing} onPress={() => setDrawing((v) => !v)} />
          ) : undefined
        }
        segments={
          <View style={styles.segmentRow}>
            <ListFilterTabs value={shown} onChange={choose} options={SEGMENTS} anchorPrefix="today.segment." />
            <View style={styles.spacer} />
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
          </View>
        }
      />
      {shown === "agenda" ? (
        <ScrollView style={styles.fill} contentContainerStyle={styles.agendaContent}>
          <TourAnchor id="today.calendar">
            <TodayCalendar selected={selected} today={today} onSelect={setSelected} />
          </TourAnchor>
          <TourAnchor id="today.agenda" style={styles.agendaBelowMonth}>
            <Agenda date={selected} onOpenItem={openItem} creatable />
          </TourAnchor>
        </ScrollView>
      ) : (
        <TourAnchor id="today.page" style={styles.fill}>
          <DailyNote key={selected} date={selected} onOpenRef={onOpenRef} drawing={drawing} onDrawingChange={setDrawing} />
        </TourAnchor>
      )}
      {sheet}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceCard },
  segmentRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  spacer: { flex: 1 },
  fill: { flex: 1, minHeight: 0 },
  agendaContent: { padding: space.lg },
  agendaBelowMonth: { marginTop: space.lg, paddingTop: space.lg, borderTopWidth: 1, borderTopColor: colors.borderSubtle },
});
