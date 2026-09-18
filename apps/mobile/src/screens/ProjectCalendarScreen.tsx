import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ProjectCalendarsPanel, ProjectCalendarsPicker } from '@companion/app';
import { colors, space } from '@companion/design-system';
import type { RootStackParamList } from '../MobileShell';
import { useProjectScope } from '../ProjectContext';

type Nav = NativeStackNavigationProp<RootStackParamList>;

// A project's Calendar tab (PLAN §6.6): the calendars the project holds — an account, one of its
// calendars, or a subscription, added with the shared picker — then what's coming up on them and
// in the project's own tasks. Items open like everywhere else on the phone: tasks and notes push
// their editors, an event its detail screen (editable there when its calendar is). The picker
// renders beside the scroll view, not in it, so its scrim covers the whole tab.
export function ProjectCalendarScreen() {
  const nav = useNavigation<Nav>();
  const projectId = useProjectScope();
  const insets = useSafeAreaInsets();
  const [picking, setPicking] = useState(false);
  if (!projectId) return null;

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxl }]}>
        <ProjectCalendarsPanel
          projectId={projectId}
          onAdd={() => setPicking(true)}
          onOpenItem={(item) => {
            if (item.kind === 'task') nav.navigate('TaskEditor', { id: item.sourceId });
            else if (item.kind === 'note') nav.navigate('NoteEditor', { id: item.sourceId });
            else nav.navigate('CalendarEvent', { item });
          }}
        />
      </ScrollView>
      {picking ? <ProjectCalendarsPicker projectId={projectId} onClose={() => setPicking(false)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
  content: { padding: space.lg },
});
