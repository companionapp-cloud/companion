import { View, StyleSheet } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { Text, space } from '@companion/design-system';

// Copy keyed by route name; both the global section routes (Chat/Tasks/Calendar) and
// the project tab routes (ProjectTasks/ProjectCalendar) resolve here.
const COPY: Record<string, string> = {
  Chat: 'Chat lands here soon. For now, your notes are a tap away.',
  Calendar: 'A calendar is coming. Time keeps happening in the meantime.',
  Tasks: 'Tasks are on the way. Until then, a note that says “do the thing” works.',
  Habits: 'Habits, streaks, and gentle nudges are on the way.',
  ProjectCalendar: 'A calendar for this project is coming soon.',
  ProjectTasks: 'Tasks for this project land in a later milestone.',
  ProjectHabits: 'Habits for this project land in a later milestone.',
};

// Stand-in for the not-yet-built sections, both global and project-scoped.
export function PlaceholderScreen() {
  const route = useRoute();
  return (
    <View style={styles.center}>
      <Text tone="tertiary" style={styles.copy}>
        {COPY[route.name] ?? 'Coming soon.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl },
  copy: { textAlign: 'center', lineHeight: 22 },
});
