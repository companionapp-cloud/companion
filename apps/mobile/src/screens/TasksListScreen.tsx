import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { Task } from '@companion/core-bridge';
import { useCore, useTasks, useProjects, ListFilterTabs, filterTasksByDue } from '@companion/app';
import { Spinner, colors, space } from '@companion/design-system';
import type { RootStackParamList } from '../MobileShell';
import { useAreaScope, useProjectScope } from '../ProjectContext';
import { CHECKBOX_INSET, CardRow, Checkbox, EmptyCaption, FAB_CLEARANCE, Fab, GroupedItem, NavAction, NavBarSegments } from '../ui/native';

// A list of tasks with a create FAB. Used globally (all tasks) and inside a project's tab
// bar, where ProjectContext scopes it to the project's member tasks and makes new tasks
// members of the project (PLAN §6.4, §6.6). The leading checkbox toggles done in place;
// tapping the row opens the full-screen editor. The filter segments live in the nav bar's
// lower storey; the rows are one grouped card, no chevrons.
export function TasksListScreen() {
  const store = useTasks();
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
      if (!cancelled) setMemberIds(new Set(rows.filter((m) => m.entityType === 'task').map((m) => m.entityId)));
    };
    void load();
    const off = core.on('nav.changed', () => void load());
    return () => {
      cancelled = true;
      off();
    };
  }, [projectId, scopeId, membershipsForProject, membershipsForArea, core]);

  // Project-scoped lists don't use the global Unsorted/All filter; they carry their own
  // due-date filter (all / upcoming / overdue) instead.
  const [dueFilter, setDueFilter] = useState<'all' | 'upcoming' | 'overdue'>('all');

  const tasks = useMemo(() => {
    if (!scopeId) return store.visible; // global list honours the Unsorted/All/Upcoming/Overdue filter
    if (!memberIds) return [];
    const members = store.tasks.filter((t) => memberIds.has(t.id));
    return dueFilter === 'all' ? members : filterTasksByDue(members, dueFilter);
  }, [store.visible, store.tasks, scopeId, memberIds, dueFilter]);

  const openTask = (id: string) => nav.navigate('TaskEditor', { id });
  const createTask = async () => {
    const task = await store.create({ title: 'Untitled task' });
    if (projectId) await addMember(projectId, 'task', task.id);
    else if (areaId) await addAreaMember(areaId, 'task', task.id);
    nav.navigate('TaskEditor', { id: task.id });
  };

  // The global list owns its stack header, so "new task" is also an action in the bar.
  // (Inside a project the header belongs to ProjectScreen; the FAB covers it.) Routed
  // through a ref so the header callback stays stable while the store's identity churns.
  const createRef = useRef(createTask);
  createRef.current = createTask;
  useLayoutEffect(() => {
    if (scopeId) return;
    nav.setOptions({
      headerRight: () => <NavAction icon="plus" label="New task" onPress={() => void createRef.current()} />,
    });
  }, [nav, scopeId]);

  if (store.loading) {
    return <Spinner label="Loading your tasks…" />;
  }

  return (
    <View style={styles.container}>
      {/* Four segments can outgrow a narrow phone, so the strip scrolls sideways. */}
      <NavBarSegments detached={!!scopeId}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.segments}>
          {!scopeId ? (
            <ListFilterTabs
              value={store.filter}
              onChange={store.setFilter}
              options={[
                { value: 'unsorted', label: 'Unsorted' },
                { value: 'all', label: 'All' },
                { value: 'upcoming', label: 'Upcoming' },
                { value: 'overdue', label: 'Overdue' },
              ]}
            />
          ) : (
            <ListFilterTabs
              value={dueFilter}
              onChange={setDueFilter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'upcoming', label: 'Upcoming' },
                { value: 'overdue', label: 'Overdue' },
              ]}
            />
          )}
        </ScrollView>
      </NavBarSegments>
      <FlatList
        data={tasks}
        keyExtractor={(t) => t.id}
        // Project tabs sit above a tab bar that already clears the home indicator.
        contentContainerStyle={[styles.list, { paddingBottom: FAB_CLEARANCE + space.xl + (scopeId ? 0 : insets.bottom) }]}
        ListEmptyComponent={
          <EmptyCaption>
            {scopeId
              ? dueFilter === 'upcoming'
                ? `No upcoming tasks in this ${areaId ? 'area' : 'project'}.`
                : dueFilter === 'overdue'
                  ? `No overdue tasks in this ${areaId ? 'area' : 'project'}.`
                  : `No tasks in this ${areaId ? 'area' : 'project'} yet. Tap + to add one.`
              : 'Nothing to do. Tap + to add a task.'}
          </EmptyCaption>
        }
        renderItem={({ item, index }) => (
          <GroupedItem index={index} count={tasks.length}>
            <CardRow
              leading={
                <Checkbox
                  checked={item.status === 'done'}
                  onPress={() => void store.setStatus(item.id, item.status === 'done' ? 'open' : 'done')}
                />
              }
              title={item.title || 'Untitled task'}
              subtitle={dueLabel(item)}
              showChevron={false}
              isLast={index === tasks.length - 1}
              separatorInset={CHECKBOX_INSET}
              onPress={() => openTask(item.id)}
            />
          </GroupedItem>
        )}
      />
      <Fab label="New task" onPress={() => void createTask()} bottomInset={scopeId ? 0 : insets.bottom} />
    </View>
  );
}

// The row subtitle: the deadline, else a start still ahead, else nothing to show.
function dueLabel(task: Task): string {
  if (task.status === 'done') return 'Completed';
  const short = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (task.dueAt && !Number.isNaN(new Date(task.dueAt).getTime())) return 'Due ' + short(task.dueAt);
  if (task.startAt && new Date(task.startAt).getTime() > Date.now()) return 'Starts ' + short(task.startAt);
  return 'No deadline';
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surfaceApp },
  segments: { flexGrow: 0 },
  list: { paddingHorizontal: space.lg, paddingTop: space.md, flexGrow: 1 },
});
