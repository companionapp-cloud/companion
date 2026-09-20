import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { Task } from '@companion/core-bridge';
import { useCore, useTasks, useProjects, ListFilterTabs, DateGroupHeading, filterBySchedule, newTaskDefaults, scheduleGroups, withoutSomeday, type ScheduleFilter } from '@companion/app';
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
  // schedule filter (all / anytime / upcoming / overdue / someday) instead.
  const [dueFilter, setDueFilter] = useState<'all' | ScheduleFilter>('all');
  const mode = scopeId ? dueFilter : store.filter;

  const tasks = useMemo(() => {
    if (!scopeId) return store.visible; // the global list honours the store's filter
    if (!memberIds) return [];
    const members = store.tasks.filter((t) => memberIds.has(t.id));
    // An area rolls up its projects' tasks, so the ones in a Someday project are filed away
    // with it; a project's own list shows its tasks whatever the project's state.
    const filedAway = areaId ? store.somedayIds : undefined;
    return dueFilter === 'all' ? withoutSomeday(members, filedAway) : filterBySchedule(members, dueFilter, filedAway);
  }, [store.visible, store.tasks, store.somedayIds, scopeId, memberIds, dueFilter, areaId]);

  // Upcoming and Overdue read as date groups (PLAN-scheduling.md §5): each a heading over its
  // own card of rows. Every other view is one card.
  const rows = useMemo<TaskListRow[]>(() => {
    const groups = scheduleGroups(tasks, mode) ?? [{ key: 'all', label: '', items: tasks }];
    return groups.flatMap((g) => [
      ...(g.label ? [{ kind: 'heading' as const, key: g.key, label: g.label, count: g.items.length }] : []),
      ...g.items.map((task, index) => ({ kind: 'task' as const, key: task.id, task, index, count: g.items.length })),
    ]);
  }, [tasks, mode]);

  const openTask = (id: string) => nav.navigate('TaskEditor', { id });
  const createTask = async () => {
    // A task added from a schedule view lands in it: Someday, tomorrow (Upcoming), today (Overdue).
    const task = await store.create({ title: 'Untitled task', ...newTaskDefaults(mode) });
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
      {/* Six segments outgrow a phone, so the strip scrolls sideways. */}
      <NavBarSegments detached={!!scopeId}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.segments}>
          {!scopeId ? (
            <ListFilterTabs
              value={store.filter}
              onChange={store.setFilter}
              options={[
                { value: 'unsorted', label: 'Unsorted' },
                { value: 'all', label: 'All' },
                { value: 'anytime', label: 'Anytime' },
                { value: 'upcoming', label: 'Upcoming' },
                { value: 'overdue', label: 'Overdue' },
                { value: 'someday', label: 'Someday' },
              ]}
            />
          ) : (
            <ListFilterTabs
              value={dueFilter}
              onChange={setDueFilter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'anytime', label: 'Anytime' },
                { value: 'upcoming', label: 'Upcoming' },
                { value: 'overdue', label: 'Overdue' },
                { value: 'someday', label: 'Someday' },
              ]}
            />
          )}
        </ScrollView>
      </NavBarSegments>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        // Project tabs sit above a tab bar that already clears the home indicator.
        contentContainerStyle={[styles.list, { paddingBottom: FAB_CLEARANCE + space.xl + (scopeId ? 0 : insets.bottom) }]}
        ListEmptyComponent={
          <EmptyCaption>{emptyTasksCaption(mode, areaId ? 'area' : projectId ? 'project' : null)}</EmptyCaption>
        }
        renderItem={({ item: row }) => {
          if (row.kind === 'heading') return <DateGroupHeading label={row.label} count={row.count} />;
          const { task: item, index, count } = row;
          return (
          <GroupedItem index={index} count={count}>
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
              isLast={index === count - 1}
              separatorInset={CHECKBOX_INSET}
              onPress={() => openTask(item.id)}
            />
          </GroupedItem>
          );
        }}
      />
      <Fab label="New task" onPress={() => void createTask()} bottomInset={scopeId ? 0 : insets.bottom} />
    </View>
  );
}

/** One row of the task list: a date-group heading, or a task with its place in its card. */
type TaskListRow =
  | { kind: 'heading'; key: string; label: string; count: number }
  | { kind: 'task'; key: string; task: Task; index: number; count: number };

function emptyTasksCaption(mode: string, where: 'area' | 'project' | null): string {
  const here = where ? ` in this ${where}` : '';
  switch (mode) {
    case 'anytime':
      return `No tasks without a start or a deadline${here}.`;
    case 'upcoming':
      return where ? `No upcoming tasks${here}.` : 'Nothing coming up.';
    case 'overdue':
      return where ? `No overdue tasks${here}.` : 'Nothing overdue.';
    case 'someday':
      return `Nothing filed under Someday${here}.`;
    default:
      return where ? `No tasks${here} yet. Tap + to add one.` : 'Nothing to do. Tap + to add a task.';
  }
}

// The row subtitle: the deadline, else a start still ahead, else nothing to show.
function dueLabel(task: Task): string {
  if (task.status === 'done') return 'Completed';
  if (task.someday) return 'Someday';
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
