import { View, StyleSheet } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { Icon, Text, colors, space, type IconName } from '@companion/design-system';

// Copy keyed by route name; both the global section routes (Chat/Tasks/Calendar) and
// the project tab routes (ProjectTasks/ProjectHabits) resolve here.
const COPY: Record<string, string> = {
  Chat: 'Chat lands here soon. For now, your notes are a tap away.',
  Calendar: 'A calendar is coming. Time keeps happening in the meantime.',
  Tasks: 'Tasks are on the way. Until then, a note that says “do the thing” works.',
  Habits: 'Habits, streaks, and gentle nudges are on the way.',
  ProjectTasks: 'Tasks for this project land in a later milestone.',
  ProjectHabits: 'Habits for this project land in a later milestone.',
};

const ICON: Record<string, IconName> = {
  Chat: 'chat',
  Calendar: 'calendar',
  Tasks: 'tasks',
  Habits: 'habits',
  ProjectTasks: 'tasks',
  ProjectHabits: 'habits',
};

// Stand-in for the not-yet-built sections, both global and project-scoped: the section's
// quiet glyph over the app's own copy, as a centred caption.
export function PlaceholderScreen() {
  const route = useRoute();
  const glyph = ICON[route.name];
  return (
    <View style={styles.center}>
      {glyph ? <Icon name={glyph} size={20} color={colors.textQuaternary} /> : null}
      <Text variant="caption" tone="tertiary" style={styles.copy}>
        {COPY[route.name] ?? 'Coming soon.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xxl, backgroundColor: colors.surfaceApp },
  copy: { textAlign: 'center', lineHeight: 18 },
});
