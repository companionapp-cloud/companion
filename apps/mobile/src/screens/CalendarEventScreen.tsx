import { useLayoutEffect } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { CalendarItemInfo } from '@companion/app';
import { colors, space } from '@companion/design-system';
import type { RootStackParamList } from '../MobileShell';

// Detail subview for a feed calendar event (PLAN §6.7). Tasks and notes push to their own
// editors; a feed event has no local entity to edit, so this read-only card shows its title,
// time, location, and description. The item is passed whole via route params (it's already a
// plain JSON object from calendar.range), so no extra fetch is needed.
export function CalendarEventScreen() {
  const nav = useNavigation();
  const route = useRoute<RouteProp<RootStackParamList, 'CalendarEvent'>>();
  const { item } = route.params;

  useLayoutEffect(() => {
    nav.setOptions({ title: item.title || 'Event' });
  }, [nav, item.title]);

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <CalendarItemInfo item={item} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
  content: { padding: space.lg },
});
