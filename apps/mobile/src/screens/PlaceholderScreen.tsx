import { View, StyleSheet } from 'react-native';
import { Text, space } from '@companion/design-system';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { TabParamList } from '../MobileShell';

const COPY: Record<string, string> = {
  Chat: 'Chat lands here soon. For now, your notes are a tab away.',
  Calendar: 'A calendar is coming. Time keeps happening in the meantime.',
  Tasks: 'Tasks are on the way. Until then, a note that says “do the thing” works.',
};

// Stand-in for the not-yet-built sections, mirroring the desktop placeholders.
export function PlaceholderScreen({ route }: BottomTabScreenProps<TabParamList>) {
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
