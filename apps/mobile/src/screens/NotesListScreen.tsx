import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { Note } from '@companion/core-bridge';
import { useCore, useNotes, useProjects, ListFilterTabs } from '@companion/app';
import { Icon, Input, Spinner, Text, colors, space } from '@companion/design-system';
import type { RootStackParamList } from '../MobileShell';
import { useAreaScope, useProjectScope } from '../ProjectContext';
import { CardRow, EmptyCaption, FAB_CLEARANCE, Fab, GroupedItem, NavAction, NavBarSegments, ROW_ICON_INSET, RowIcon } from '../ui/native';

// A list of notes with a create FAB. Used both globally (all notes) and inside a
// project's tab bar, where ProjectContext scopes it to that project's member notes and
// makes new notes members of the project (PLAN §6.6). Tapping a note pushes the
// full-screen editor on the root stack. Globally the Unsorted/All segments sit in the nav
// bar's lower storey, search below the bar, then one grouped card of rows.
export function NotesListScreen() {
  const store = useNotes();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const projectId = useProjectScope();
  const areaId = useAreaScope();
  // The container this list is scoped to — a project, or an area (whose list is its whole tree).
  const scopeId = projectId ?? areaId;
  const insets = useSafeAreaInsets();
  const { core } = useCore();
  const { membershipsForProject, membershipsForArea, addMember, addAreaMember } = useProjects();

  // When scoped to a project, track its member note ids and keep them fresh as
  // memberships change (locally or via sync).
  const [memberIds, setMemberIds] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!scopeId) {
      setMemberIds(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      const rows = (await (projectId ? membershipsForProject(projectId) : membershipsForArea(scopeId, true))) ?? [];
      if (!cancelled) setMemberIds(new Set(rows.filter((m) => m.entityType === 'note').map((m) => m.entityId)));
    };
    void load();
    const off = core.on('nav.changed', () => void load());
    return () => {
      cancelled = true;
      off();
    };
  }, [projectId, scopeId, membershipsForProject, membershipsForArea, core]);

  const [query, setQuery] = useState('');

  const notes = useMemo(() => {
    const base = !scopeId
      ? store.visible // global list honours the Unsorted/All filter
      : !memberIds
        ? []
        : store.notes.filter((n) => memberIds.has(n.id));
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter((n) => n.title.toLowerCase().includes(q) || n.contentMd.toLowerCase().includes(q));
  }, [store.visible, store.notes, scopeId, memberIds, query]);

  const openNote = (id: string) => nav.navigate('NoteEditor', { id });
  const createNote = async () => {
    const note = await store.create();
    if (projectId) await addMember(projectId, 'note', note.id);
    else if (areaId) await addAreaMember(areaId, 'note', note.id);
    nav.navigate('NoteEditor', { id: note.id });
  };

  // The global list owns its stack header, so "new note" is also an action in the bar.
  // (Inside a project the header belongs to ProjectScreen; the FAB covers it.) Routed
  // through a ref so the header callback stays stable while the store's identity churns.
  const createRef = useRef(createNote);
  createRef.current = createNote;
  useLayoutEffect(() => {
    if (scopeId) return;
    nav.setOptions({
      headerRight: () => <NavAction icon="plus" label="New note" onPress={() => void createRef.current()} />,
    });
  }, [nav, scopeId]);

  if (store.loading) {
    return <Spinner label="Loading your notes…" />;
  }

  return (
    <View style={styles.container}>
      {!scopeId ? (
        <NavBarSegments>
          <ListFilterTabs
            value={store.filter}
            onChange={store.setFilter}
            options={[
              { value: 'unsorted', label: 'Unsorted' },
              { value: 'all', label: 'All' },
            ]}
          />
        </NavBarSegments>
      ) : null}
      <View style={styles.search}>
        <Input
          placeholder="Search notes"
          value={query}
          onChangeText={setQuery}
          leadingIcon={<Icon name="search" size={15} color={colors.textTertiary} />}
        />
      </View>
      <FlatList
        data={notes}
        keyExtractor={(n) => n.id}
        // Project tabs sit above a tab bar that already clears the home indicator.
        contentContainerStyle={[styles.list, { paddingBottom: FAB_CLEARANCE + space.xl + (scopeId ? 0 : insets.bottom) }]}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <EmptyCaption>
            {query
              ? 'No notes match that.'
              : scopeId
                ? `No notes in this ${areaId ? 'area' : 'project'} yet. Tap + to add one.`
                : 'Nothing here yet. Tap + to start a note.'}
          </EmptyCaption>
        }
        renderItem={({ item, index }) => (
          <GroupedItem index={index} count={notes.length}>
            <CardRow
              leading={<RowIcon name={item.date ? 'today' : 'file'} />}
              separatorInset={ROW_ICON_INSET}
              title={item.title || 'Untitled'}
              subtitle={preview(item)}
              trailing={
                <Text variant="mono" tone="tertiary">
                  {relTime(item.updatedAt)}
                </Text>
              }
              isLast={index === notes.length - 1}
              onPress={() => openNote(item.id)}
            />
          </GroupedItem>
        )}
      />
      <Fab label="New note" onPress={() => void createNote()} bottomInset={scopeId ? 0 : insets.bottom} />
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
  search: { paddingHorizontal: space.lg, paddingTop: space.md },
  list: { paddingHorizontal: space.lg, paddingTop: space.md, flexGrow: 1 },
});
