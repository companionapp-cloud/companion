import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { Note } from '@companion/core-bridge';
import { useNotes } from '@companion/app';
import { Icon, ListRow, Spinner, Text, colors, space } from '@companion/design-system';
import type { RootStackParamList } from '../MobileShell';

// The Notes tab: a scrollable list of notes with a create FAB. Tapping a note pushes
// the full-screen editor on the root stack (above the tab bar).
export function NotesListScreen() {
  const store = useNotes();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  const openNote = (id: string) => nav.navigate('NoteEditor', { id });
  const createNote = async () => {
    const note = await store.create();
    nav.navigate('NoteEditor', { id: note.id });
  };

  if (store.loading) {
    return <Spinner label="Loading your notes…" />;
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={store.notes}
        keyExtractor={(n) => n.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text tone="tertiary" style={styles.empty}>
            Nothing here yet. Tap + to start a note.
          </Text>
        }
        renderItem={({ item }) => (
          <ListRow
            icon={<Icon name="file" size={18} color={colors.textTertiary} />}
            title={item.title || 'Untitled'}
            subtitle={preview(item)}
            onPress={() => openNote(item.id)}
          />
        )}
      />
      <Pressable style={styles.fab} onPress={createNote} aria-label="New note">
        <Icon name="plus" size={24} color={colors.textInverse} />
      </Pressable>
    </View>
  );
}

function preview(n: Note): string {
  const body = n.contentMd.replace(/\s+/g, ' ').trim();
  return body || 'No additional text';
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surfaceApp },
  list: { padding: space.md, gap: 2, flexGrow: 1 },
  empty: { textAlign: 'center', marginTop: space.xxl },
  fab: {
    position: 'absolute',
    right: space.xl,
    bottom: space.xl,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
});
