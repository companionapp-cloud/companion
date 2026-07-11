import { useLayoutEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { TodayCalendar, Agenda, useCalendar, todayISO, formatFullDate } from '@companion/app';
import { Icon, IconButton, Text, colors, space } from '@companion/design-system';
import type { RootStackParamList } from '../MobileShell';

type Nav = NativeStackNavigationProp<RootStackParamList>;

// Mobile Calendar (PLAN §6.7): the 7-column week grid the desktop shows is too cramped on a
// phone, so this is a stacked day view — a month picker to choose a day, then that day's
// agenda (merged feed events, due tasks, dated notes). Reuses the shared TodayCalendar +
// Agenda so the merge logic stays identical across shells ([[mobile-needs-own-shell]]).
export function CalendarScreen() {
  const nav = useNavigation<Nav>();
  const { refresh } = useCalendar();
  const [selected, setSelected] = useState(todayISO);
  const [refreshing, setRefreshing] = useState(false);
  const today = todayISO();

  const onRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  };

  // A refresh button in the nav header re-fetches the ICS feeds now (PLAN §6.7).
  useLayoutEffect(() => {
    nav.setOptions({
      headerRight: () => (
        <IconButton label="Refresh calendars" size="sm" onPress={onRefresh} disabled={refreshing}>
          {refreshing ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : (
            <Icon name="refresh" size={18} color={colors.textSecondary} />
          )}
        </IconButton>
      ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav, refreshing]);

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.calCard}>
        <TodayCalendar selected={selected} today={today} onSelect={setSelected} allowFuture />
      </View>
      <Text variant="mono" tone="tertiary" style={styles.dateLabel}>
        {formatFullDate(selected)}
      </Text>
      <Agenda
        date={selected}
        onOpenItem={(item) => {
          if (item.kind === 'task') nav.push('TaskEditor', { id: item.sourceId });
          else if (item.kind === 'note') nav.push('NoteEditor', { id: item.sourceId });
          else nav.push('CalendarEvent', { item });
        }}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceCard },
  content: { padding: space.lg, paddingBottom: space.xxl },
  calCard: {
    paddingBottom: space.lg,
    marginBottom: space.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  dateLabel: { marginBottom: space.md, fontSize: 12 },
});
