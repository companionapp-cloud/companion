import { useLayoutEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { CalendarItemInfo, EventEditorDialog } from '@companion/app';
import { Button, colors, space } from '@companion/design-system';
import type { RootStackParamList } from '../MobileShell';

// Detail subview for a calendar event (PLAN §6.7). Tasks and notes push to their own editors; an
// event shows its title, time, location, and description. A subscription event is read-only; one
// in a CalDAV calendar (PLAN-caldav.md) can be edited or deleted from here. The item is passed
// whole via route params (it's already a plain JSON object from calendar.range), so no extra
// fetch is needed — and after an edit the screen pops, since that snapshot is then stale.
export function CalendarEventScreen() {
  const nav = useNavigation();
  const route = useRoute<RouteProp<RootStackParamList, 'CalendarEvent'>>();
  const { item } = route.params;
  const insets = useSafeAreaInsets();
  const [editing, setEditing] = useState(false);

  useLayoutEffect(() => {
    nav.setOptions({ title: item.title || 'Event' });
  }, [nav, item.title]);

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxl }]}>
        <CalendarItemInfo item={item} />
        {item.editable ? (
          <View style={styles.actions}>
            <Button variant="secondary" label="Edit event" onPress={() => setEditing(true)} />
          </View>
        ) : null}
      </ScrollView>
      {editing ? (
        <EventEditorDialog
          target={{ mode: 'edit', item }}
          onClose={() => setEditing(false)}
          onSaved={() => nav.goBack()}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
  content: { padding: space.lg },
  actions: { flexDirection: 'row', marginTop: space.lg },
});
