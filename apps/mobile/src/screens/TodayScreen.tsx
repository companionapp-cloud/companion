import { useEffect, useLayoutEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { DailyNote, TodayCalendar, Agenda, ListFilterTabs, TourAnchor, todayISO, useTourView, type FilterOption } from '@companion/app';
import type { LinkRef } from '@companion/editor';
import { Button, colors, space } from '@companion/design-system';
import type { RootStackParamList } from '../MobileShell';
import { NavAction, NavActions, NavBarSegments } from '../ui/native';
import { loadTodaySegment, saveTodaySegment, type TodaySegment } from '../todayStorage';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const SEGMENTS: FilterOption<TodaySegment>[] = [
  { value: 'note', label: 'Note' },
  { value: 'agenda', label: 'Agenda' },
];

// Mobile "Today": the daily note and the day's agenda as two segments under the nav bar. The
// note gets the full height (content is big); the other segment is the month over the day's
// agenda. A daily note is an ordinary note stamped with today's `date`; it isn't created until
// the user types. The desktop shell sets the month and agenda in a side panel beside the note,
// which a phone has no room for. The last segment is remembered across launches, and picking a
// day in the month keeps the agenda up for that day while the note follows the same day. Shares
// DailyNote/TodayCalendar/Agenda with the desktop screen (PLAN §6.x).
export function TodayScreen() {
  const nav = useNavigation<Nav>();
  // Opened on a specific day (a daily note followed from the graph)? Seed the selection with it,
  // show its note, and follow it if the route's date changes.
  const requestedDay = useRoute<RouteProp<RootStackParamList, 'Today'>>().params?.date;
  const [selected, setSelected] = useState(() => requestedDay ?? todayISO());
  const [segment, setSegment] = useState<TodaySegment>(() => (requestedDay ? 'note' : loadTodaySegment()));
  useEffect(() => {
    if (!requestedDay) return;
    setSelected(requestedDay);
    setSegment('note');
  }, [requestedDay]);
  const [today, setToday] = useState(todayISO);
  // Drawing on the day's note (PLAN-drawing.md); the drawing bar shows under the note.
  const [drawing, setDrawing] = useState(false);
  const isToday = selected === today;
  // A tutorial step can need one side of the page (TourStep.view); it shows over the user's own.
  const tourView = useTourView();
  const shown: TodaySegment = tourView === 'today.note' ? 'note' : tourView === 'today.agenda' ? 'agenda' : segment;

  const choose = (next: TodaySegment) => {
    setSegment(next);
    saveTodaySegment(next);
    if (next !== 'note') setDrawing(false);
  };

  // The pen draws on the note, so it's in the bar only while the note shows.
  useLayoutEffect(() => {
    nav.setOptions({
      headerRight:
        shown === 'note'
          ? () => (
              <NavActions>
                <NavAction icon="pen" label={drawing ? 'Stop drawing' : 'Draw on note'} active={drawing} onPress={() => setDrawing((v) => !v)} />
              </NavActions>
            )
          : undefined,
    });
  }, [nav, shown, drawing]);

  // Clicking a chip in the note pushes its target onto the stack (matches NoteEditorScreen).
  const onOpenRef = (ref: LinkRef) => {
    if (ref.type === 'task') nav.push('TaskEditor', { id: ref.id });
    else if (ref.type === 'note') nav.push('NoteEditor', { id: ref.id });
  };

  return (
    <View style={styles.root}>
      <NavBarSegments>
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
      </NavBarSegments>
      {shown === 'agenda' ? (
        <ScrollView style={styles.agenda} contentContainerStyle={styles.agendaContent}>
          <TourAnchor id="today.calendar">
            <TodayCalendar selected={selected} today={today} onSelect={setSelected} />
          </TourAnchor>
          <TourAnchor id="today.agenda" style={styles.agendaBelowMonth}>
            <Agenda
              date={selected}
              onOpenItem={(item) => {
                if (item.kind === 'task') nav.push('TaskEditor', { id: item.sourceId });
                else if (item.kind === 'project') nav.push('Project', { projectId: item.sourceId });
                else if (item.kind === 'note') nav.push('NoteEditor', { id: item.sourceId });
                else nav.push('CalendarEvent', { item });
              }}
              creatable
            />
          </TourAnchor>
        </ScrollView>
      ) : (
        <TourAnchor id="today.page" style={styles.note}>
          <DailyNote
            key={selected}
            date={selected}
            onOpenRef={onOpenRef}
            headingPadding={20}
            drawing={drawing}
            onDrawingChange={setDrawing}
          />
        </TourAnchor>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
  segmentRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  spacer: { flex: 1 },
  agenda: { flex: 1, backgroundColor: colors.surfaceCard },
  agendaContent: { padding: space.lg },
  agendaBelowMonth: {
    marginTop: space.lg,
    paddingTop: space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  // Top padding so the date heading breathes under the segments; the editor body brings its own
  // horizontal inset, which the heading matches through headingPadding.
  note: { flex: 1, paddingTop: space.xl, backgroundColor: colors.surfaceCard },
});
