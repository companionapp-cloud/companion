import { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { Note } from '@companion/core-bridge';
import { useCore, useNotes, useProjects, ListFilterTabs } from '@companion/app';
import { Icon, Spinner, Text, colors, space } from '@companion/design-system';
import type { RootStackParamList } from '../MobileShell';
import { useProjectScope } from '../ProjectContext';
import { CardRow } from '../ui/native';

// A list of notes with a create FAB. Used both globally (all notes) and inside a
// project's tab bar, where ProjectContext scopes it to that project's member notes and
// makes new notes members of the project (PLAN §6.6). Tapping a note pushes the
// full-screen editor on the root stack.
export function NotesListScreen() {
  const store = useNotes();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const projectId = useProjectScope();
  const { core } = useCore();
  const { membershipsForProject, addMember } = useProjects();

  // When scoped to a project, track its member note ids and keep them fresh as
  // memberships change (locally or via sync).
  const [memberIds, setMemberIds] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!projectId) {
      setMemberIds(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      const rows = await membershipsForProject(projectId);
      if (!cancelled) setMemberIds(new Set(rows.filter((m) => m.entityType === 'note').map((m) => m.entityId)));
    };
    void load();
    const off = core.on('nav.changed', () => void load());
    return () => {
      cancelled = true;
      off();
    };
  }, [projectId, membershipsForProject, core]);

  const notes = useMemo(() => {
    if (!projectId) return store.visible; // global list honours the Unsorted/All filter
    if (!memberIds) return [];
    return store.notes.filter((n) => memberIds.has(n.id));
  }, [store.visible, store.notes, projectId, memberIds]);

  const openNote = (id: string) => nav.navigate('NoteEditor', { id });
  const createNote = async () => {
    const note = await store.create();
    if (projectId) await addMember(projectId, 'note', note.id);
    nav.navigate('NoteEditor', { id: note.id });
  };

  if (store.loading) {
    return <Spinner label="Loading your notes…" />;
  }

  return (
    <View style={styles.container}>
      {!projectId ? (
        <View style={styles.filterBar}>
          <ListFilterTabs
            value={store.filter}
            onChange={store.setFilter}
            options={[
              { value: 'unsorted', label: 'Unsorted' },
              { value: 'all', label: 'All' },
            ]}
          />
        </View>
      ) : null}
      <FlatList
        data={notes}
        keyExtractor={(n) => n.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text tone="tertiary" style={styles.empty}>
            {projectId ? 'No notes in this project yet. Tap + to add one.' : 'Nothing here yet. Tap + to start a note.'}
          </Text>
        }
        renderItem={({ item }) => (
          <CardRow
            leading={<Icon name="file" size={19} color={colors.textTertiary} />}
            title={item.title || 'Untitled'}
            subtitle={preview(item)}
            trailing={
              <Text variant="mono" tone="tertiary" style={styles.time}>
                {relTime(item.updatedAt)}
              </Text>
            }
            divided={false}
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

// Compact relative time (e.g. "2h", "3d") for the row's trailing metadata.
function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return 'now';
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h`;
  const d = h / 24;
  if (d < 7) return `${Math.floor(d)}d`;
  return `${Math.floor(d / 7)}w`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surfaceApp },
  filterBar: { paddingHorizontal: space.md, paddingTop: space.sm },
  list: { paddingHorizontal: space.md, paddingVertical: space.sm, gap: 2, flexGrow: 1 },
  time: { fontSize: 11 },
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
