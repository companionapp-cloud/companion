import { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { Task } from '@companion/core-bridge';
import { useCore, useTasks, useProjects, Checkbox } from '@companion/app';
import { Icon, Spinner, Text, colors, space } from '@companion/design-system';
import type { RootStackParamList } from '../MobileShell';
import { useProjectScope } from '../ProjectContext';
import { CardRow } from '../ui/native';

// A list of tasks with a create FAB. Used globally (all tasks) and inside a project's tab
// bar, where ProjectContext scopes it to the project's member tasks and makes new tasks
// members of the project (PLAN §6.4, §6.6). The leading checkbox toggles done in place;
// tapping the row opens the full-screen editor.
export function TasksListScreen() {
  const store = useTasks();
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
      if (!cancelled) setMemberIds(new Set(rows.filter((m) => m.entityType === 'task').map((m) => m.entityId)));
    };
    void load();
    const off = core.on('nav.changed', () => void load());
    return () => {
      cancelled = true;
      off();
    };
  }, [projectId, membershipsForProject, core]);

  const tasks = useMemo(() => {
    if (!projectId) return store.tasks;
    if (!memberIds) return [];
    return store.tasks.filter((t) => memberIds.has(t.id));
  }, [store.tasks, projectId, memberIds]);

  const openTask = (id: string) => nav.navigate('TaskEditor', { id });
  const createTask = async () => {
    const task = await store.create({ title: 'Untitled task' });
    if (projectId) await addMember(projectId, 'task', task.id);
    nav.navigate('TaskEditor', { id: task.id });
  };

  if (store.loading) {
    return <Spinner label="Loading your tasks…" />;
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={tasks}
        keyExtractor={(t) => t.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text tone="tertiary" style={styles.empty}>
            {projectId ? 'No tasks in this project yet. Tap + to add one.' : 'Nothing to do. Tap + to add a task.'}
          </Text>
        }
        renderItem={({ item }) => (
          <CardRow
            leading={
              <Checkbox
                checked={item.status === 'done'}
                onPress={() => void store.setStatus(item.id, item.status === 'done' ? 'open' : 'done')}
                size={22}
              />
            }
            title={item.title || 'Untitled task'}
            subtitle={dueLabel(item)}
            showChevron={false}
            divided={false}
            onPress={() => openTask(item.id)}
          />
        )}
      />
      <Pressable style={styles.fab} onPress={createTask} aria-label="New task">
        <Icon name="plus" size={24} color={colors.textInverse} />
      </Pressable>
    </View>
  );
}

function dueLabel(task: Task): string {
  if (task.status === 'done') return 'Completed';
  if (!task.dueAt) return 'No due date';
  const d = new Date(task.dueAt);
  if (Number.isNaN(d.getTime())) return 'No due date';
  return 'Due ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surfaceApp },
  list: { paddingHorizontal: space.md, paddingVertical: space.sm, gap: 2, flexGrow: 1 },
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
