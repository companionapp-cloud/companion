import { useLayoutEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { DailyNote, TodayCalendar, todayISO, formatFullDate } from '@companion/app';
import type { LinkRef } from '@companion/editor';
import { Icon, IconButton, Text, colors, font, radius, space } from '@companion/design-system';
import type { RootStackParamList } from '../MobileShell';

type Nav = NativeStackNavigationProp<RootStackParamList>;

// Mobile "Today": the full-height daily-note editor (content is big), with the mini calendar
// tucked into a collapsible panel above it (the detail is small). A daily note is an ordinary
// note stamped with today's `date`; it isn't created until the user types. The desktop shell
// puts the calendar in a side panel — no room for that on a phone, so it toggles from the
// header instead. Shares DailyNote/TodayCalendar with the desktop screen (PLAN §6.x).
export function TodayScreen() {
  const nav = useNavigation<Nav>();
  const [selected, setSelected] = useState(todayISO);
  const [today, setToday] = useState(todayISO);
  const [showCalendar, setShowCalendar] = useState(false);
  const isToday = selected === today;

  // Clicking a chip in the note pushes its target onto the stack (matches NoteEditorScreen).
  const onOpenRef = (ref: LinkRef) => {
    if (ref.type === 'task') nav.push('TaskEditor', { id: ref.id });
    else if (ref.type === 'note') nav.push('NoteEditor', { id: ref.id });
  };

  useLayoutEffect(() => {
    nav.setOptions({
      title: 'Today',
      headerRight: () => (
        <View style={styles.headerActions}>
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
            label={showCalendar ? 'Hide calendar' : 'Show calendar'}
            size="sm"
            active={showCalendar}
            onPress={() => setShowCalendar((v) => !v)}
          >
            <Icon name="calendar" size={18} color={showCalendar ? colors.accent : colors.textSecondary} />
          </IconButton>
        </View>
      ),
    });
  }, [nav, isToday, showCalendar]);

  return (
    <View style={styles.root}>
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
        </View>
      ) : null}
      <View style={styles.note}>
        <DailyNote key={selected} date={selected} onOpenRef={onOpenRef} headingPadding={20} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceCard },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  resetBtn: { minHeight: 36, paddingHorizontal: space.sm, justifyContent: 'center' },
  calCard: {
    padding: space.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.surfaceCard,
  },
  // Top padding so the date heading breathes under the nav header; the editor body brings
  // its own horizontal inset, so only the vertical gap is added here.
  note: { flex: 1, paddingTop: space.xl },
});
