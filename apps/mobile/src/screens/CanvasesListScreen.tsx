import { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { Canvas } from '@companion/core-bridge';
import { useCore, useCanvases, useProjects, timeAgo } from '@companion/app';
import { Icon, Spinner, Text, colors, space } from '@companion/design-system';
import type { RootStackParamList } from '../MobileShell';
import { useProjectScope } from '../ProjectContext';
import { CardRow } from '../ui/native';

// A list of canvas boards with a create FAB (PLAN-canvases.md). Used globally (all
// boards) and inside a project's tab bar, where ProjectContext scopes it to that
// project's member boards and makes new boards members of the project. Tapping a board
// pushes the full-screen canvas on the root stack.
export function CanvasesListScreen() {
  const store = useCanvases();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const projectId = useProjectScope();
  const { core } = useCore();
  const { membershipsForProject, addMember } = useProjects();

  const [memberIds, setMemberIds] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!projectId) {
      setMemberIds(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      const rows = await membershipsForProject(projectId);
      if (!cancelled) setMemberIds(new Set(rows.filter((m) => m.entityType === 'canvas').map((m) => m.entityId)));
    };
    void load();
    const offNav = core.on('nav.changed', () => void load());
    const offData = core.on('data.changed', () => void load());
    return () => {
      cancelled = true;
      offNav();
      offData();
    };
  }, [projectId, membershipsForProject, core]);

  const canvases = useMemo(() => {
    if (!projectId) return store.canvases;
    if (!memberIds) return [];
    return store.canvases.filter((c) => memberIds.has(c.id));
  }, [store.canvases, projectId, memberIds]);

  const openCanvas = (id: string) => nav.navigate('Canvas', { id });
  const createCanvas = async () => {
    const c = await store.create();
    if (projectId) await addMember(projectId, 'canvas', c.id);
    openCanvas(c.id);
  };

  if (store.loading) return <Spinner label="Loading your canvases…" />;

  return (
    <View style={styles.container}>
      <FlatList
        data={canvases}
        keyExtractor={(c) => c.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text tone="tertiary" style={styles.empty}>
            {projectId ? 'No canvases in this project yet. Tap + to start a board.' : 'No canvases yet. Tap + to start a board.'}
          </Text>
        }
        renderItem={({ item }) => <CanvasRow canvas={item} onPress={() => openCanvas(item.id)} />}
      />
      <Pressable style={styles.fab} onPress={() => void createCanvas()} aria-label="New canvas">
        <Icon name="plus" size={24} color={colors.textInverse} />
      </Pressable>
    </View>
  );
}

function CanvasRow({ canvas, onPress }: { canvas: Canvas; onPress: () => void }) {
  return (
    <CardRow
      leading={<Icon name="canvas" size={19} color={colors.textTertiary} />}
      title={canvas.name || 'Untitled canvas'}
      subtitle={`Edited ${timeAgo(canvas.updatedAt)}`}
      divided={false}
      onPress={onPress}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surfaceApp },
  list: { paddingHorizontal: space.md, paddingVertical: space.sm, gap: 2, flexGrow: 1 },
  empty: { padding: space.xl, textAlign: 'center', lineHeight: 20 },
  fab: {
    position: 'absolute',
    right: space.xl,
    bottom: space.xl,
    width: 56,
    height: 56,
    borderRadius: 18,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.accent,
    shadowOpacity: 0.35,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
});
