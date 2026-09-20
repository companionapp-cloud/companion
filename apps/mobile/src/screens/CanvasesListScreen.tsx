import { useEffect, useMemo, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { Canvas } from '@companion/core-bridge';
import { useCore, useCanvases, useProjects, timeAgo } from '@companion/app';
import { Spinner, colors, space } from '@companion/design-system';
import type { RootStackParamList } from '../MobileShell';
import { useAreaScope, useProjectScope } from '../ProjectContext';
import { CardRow, EmptyCaption, FAB_CLEARANCE, Fab, GroupedItem, ROW_ICON_INSET, RowIcon } from '../ui/native';

// A list of canvas boards with a create FAB (PLAN-canvases.md). Used globally (all
// boards) and inside a project's tab bar, where ProjectContext scopes it to that
// project's member boards and makes new boards members of the project. Tapping a board
// pushes the full-screen canvas on the root stack.
export function CanvasesListScreen() {
  const store = useCanvases();
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const projectId = useProjectScope();
  const areaId = useAreaScope();
  // The container this list is scoped to — a project, or an area (whose list is its whole tree).
  const scopeId = projectId ?? areaId;
  const insets = useSafeAreaInsets();
  const { core } = useCore();
  const { membershipsForProject, membershipsForArea, addMember, addAreaMember } = useProjects();

  const [memberIds, setMemberIds] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!scopeId) {
      setMemberIds(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      const rows = (await (projectId ? membershipsForProject(projectId) : membershipsForArea(scopeId, true))) ?? [];
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
  }, [projectId, scopeId, membershipsForProject, membershipsForArea, core]);

  const canvases = useMemo(() => {
    if (!scopeId) return store.canvases;
    if (!memberIds) return [];
    return store.canvases.filter((c) => memberIds.has(c.id));
  }, [store.canvases, scopeId, memberIds]);

  const openCanvas = (id: string) => nav.navigate('Canvas', { id });
  const createCanvas = async () => {
    const c = await store.create();
    if (projectId) await addMember(projectId, 'canvas', c.id);
    else if (areaId) await addAreaMember(areaId, 'canvas', c.id);
    openCanvas(c.id);
  };

  if (store.loading) return <Spinner label="Loading your canvases…" />;

  return (
    <View style={styles.container}>
      <FlatList
        data={canvases}
        keyExtractor={(c) => c.id}
        // Project tabs sit above a tab bar that already clears the home indicator.
        contentContainerStyle={[styles.list, { paddingBottom: FAB_CLEARANCE + space.xl + (scopeId ? 0 : insets.bottom) }]}
        ListEmptyComponent={
          <EmptyCaption>
            {scopeId ? `No canvases in this ${areaId ? 'area' : 'project'} yet. Tap + to start a board.` : 'No canvases yet. Tap + to start a board.'}
          </EmptyCaption>
        }
        renderItem={({ item, index }) => (
          <GroupedItem index={index} count={canvases.length}>
            <CanvasRow canvas={item} isLast={index === canvases.length - 1} onPress={() => openCanvas(item.id)} />
          </GroupedItem>
        )}
      />
      <Fab label="New canvas" onPress={() => void createCanvas()} bottomInset={scopeId ? 0 : insets.bottom} />
    </View>
  );
}

function CanvasRow({ canvas, isLast, onPress }: { canvas: Canvas; isLast: boolean; onPress: () => void }) {
  return (
    <CardRow
      leading={<RowIcon name="canvas" />}
      separatorInset={ROW_ICON_INSET}
      title={canvas.name || 'Untitled canvas'}
      subtitle={`Edited ${timeAgo(canvas.updatedAt)}`}
      isLast={isLast}
      onPress={onPress}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surfaceApp },
  list: { paddingHorizontal: space.lg, paddingTop: space.lg, flexGrow: 1 },
});
