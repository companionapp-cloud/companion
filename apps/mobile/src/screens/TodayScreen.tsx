import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { DailyNote, TodayCalendar, Agenda, todayISO } from '@companion/app';
import type { LinkRef } from '@companion/editor';
import { Button, Icon, IconButton, colors, space } from '@companion/design-system';
import type { RootStackParamList } from '../MobileShell';
import { loadShowAgenda, saveShowAgenda } from '../todayStorage';

type Nav = NativeStackNavigationProp<RootStackParamList>;

// Mobile "Today": the full-height daily-note editor (content is big), with the month and
// the day's agenda in a panel above it (the detail is small). A daily note is an ordinary
// note stamped with today's `date`; it isn't created until the user types. The desktop
// shell puts both in a side panel — no room for that on a phone, so each has its own
// toggle in an action row under the nav bar. The agenda toggle is remembered across
// launches; the month is a day picker, so it collapses once a day is picked. Shares
// DailyNote/TodayCalendar/Agenda with the desktop screen (PLAN §6.x).
export function TodayScreen() {
  const nav = useNavigation<Nav>();
  // Opened on a specific day (a daily note followed from the graph)? Seed the selection
  // with it and follow it if the route's date changes.
  const requestedDay = useRoute<RouteProp<RootStackParamList, 'Today'>>().params?.date;
  const [selected, setSelected] = useState(() => requestedDay ?? todayISO());
  useEffect(() => {
    if (requestedDay) setSelected(requestedDay);
  }, [requestedDay]);
  const [today, setToday] = useState(todayISO);
  const [showCalendar, setShowCalendar] = useState(false);
  const [showAgenda, setShowAgenda] = useState(loadShowAgenda);
  const isToday = selected === today;

  const toggleAgenda = () => {
    const next = !showAgenda;
    setShowAgenda(next);
    saveShowAgenda(next);
  };

  // Clicking a chip in the note pushes its target onto the stack (matches NoteEditorScreen).
  const onOpenRef = (ref: LinkRef) => {
    if (ref.type === 'task') nav.push('TaskEditor', { id: ref.id });
    else if (ref.type === 'note') nav.push('NoteEditor', { id: ref.id });
  };

  return (
    <View style={styles.root}>
      <View style={styles.actions}>
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
        <IconButton label={showAgenda ? 'Hide agenda' : 'Show agenda'} size="lg" active={showAgenda} onPress={toggleAgenda}>
          <Icon name="listBullet" size={18} color={showAgenda ? colors.textAccent : colors.textSecondary} />
        </IconButton>
        <IconButton
          label={showCalendar ? 'Hide calendar' : 'Show calendar'}
          size="lg"
          active={showCalendar}
          onPress={() => setShowCalendar((v) => !v)}
        >
          <Icon name="calendar" size={18} color={showCalendar ? colors.textAccent : colors.textSecondary} />
        </IconButton>
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
              <Agenda
                date={selected}
                onOpenItem={(item) => {
                  if (item.kind === 'task') nav.push('TaskEditor', { id: item.sourceId });
                  else if (item.kind === 'note') nav.push('NoteEditor', { id: item.sourceId });
                  else nav.push('CalendarEvent', { item });
                }}
              />
            </View>
          ) : null}
        </ScrollView>
      ) : null}
      <View style={styles.note}>
        <DailyNote key={selected} date={selected} onOpenRef={onOpenRef} headingPadding={20} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  spacer: { flex: 1 },
  panel: {
    flexGrow: 0,
    maxHeight: '62%',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.surfaceCard,
  },
  panelContent: { padding: space.lg },
  agendaBelowMonth: {
    marginTop: space.lg,
    paddingTop: space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  // Top padding so the date heading breathes under the action row; the editor body brings
  // its own horizontal inset, so only the vertical gap is added here.
  note: { flex: 1, paddingTop: space.xl, backgroundColor: colors.surfaceCard },
});
