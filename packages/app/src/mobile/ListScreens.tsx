import { useEffect, useMemo, useState } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import type { Note, Task } from "@companion/core-bridge";
import { Icon, Input, Spinner, Text, colors, space } from "@companion/design-system";
import { useNav } from "../nav-context";
import { useCore } from "../CoreContext";
import { useNotes } from "../NotesProvider";
import { useTasks } from "../TasksProvider";
import { DateGroupHeading } from "../TaskGroups";
import { filterBySchedule, newTaskDefaults, scheduleGroups, withoutSomeday, type ScheduleFilter } from "../taskSchedule";
import { useProjects } from "../ProjectsProvider";
import { ListFilterTabs } from "../ListFilterMenu";
import { CHECKBOX_INSET, CardRow, Checkbox, EmptyCaption, FAB_CLEARANCE, Fab, GroupedItem, NavAction, NavBar, ROW_ICON_INSET, RowIcon } from "./ui";
import { TourAnchor } from "../onboarding/anchors";
import { UNTITLED } from "../untitled";

// Full-screen browse lists for the mobile web shell — ports of the native app's
// NotesListScreen/TasksListScreen. Used globally (all items) and inside the project
// screen, where `projectId` scopes the list to the project's members and makes new
// items members of it (PLAN §6.6). Tapping a row pushes the full-screen editor.
//
// Native chrome: the global lists own a nav bar with their segmented filter *in* it and
// search directly beneath; inside a project the project screen owns the bar, so the list
// renders bare. Rows are one contiguous grouped card with inset hairlines.

/** Tracks a container's member ids of one entity type, refreshed as memberships change. The
 *  container is a project, or — with `areaId` — an area, whose members are its whole tree: what
 *  is filed directly in it plus what its projects hold (PLAN-areas.md §3). */
export function useMemberIds(projectId: string | undefined, entityType: "note" | "task" | "canvas", areaId?: string): Set<string> | null {
  const { core } = useCore();
  const { membershipsForProject, membershipsForArea } = useProjects();
  const [memberIds, setMemberIds] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!projectId && !areaId) {
      setMemberIds(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      const rows = (await (projectId ? membershipsForProject(projectId) : membershipsForArea(areaId ?? "", true))) ?? [];
      if (!cancelled) setMemberIds(new Set(rows.filter((m) => m.entityType === entityType).map((m) => m.entityId)));
    };
    void load();
    const off = core.on("nav.changed", () => void load());
    return () => {
      cancelled = true;
      off();
    };
  }, [projectId, areaId, entityType, membershipsForProject, membershipsForArea, core]);
  return memberIds;
}

export function NotesListScreen({ projectId, areaId }: { projectId?: string; areaId?: string }) {
  const store = useNotes();
  const nav = useNav();
  const { addMember, addAreaMember } = useProjects();
  const memberIds = useMemberIds(projectId, "note", areaId);
  // Scoped to a project or an area: the host screen owns the nav bar, and new notes are filed there.
  const scoped = !!(projectId || areaId);
  const [query, setQuery] = useState("");

  const notes = useMemo(() => {
    const base = !scoped
      ? store.visible // global list honours the Unsorted/All filter
      : !memberIds
        ? []
        : store.notes.filter((n) => memberIds.has(n.id));
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter((n) => n.title.toLowerCase().includes(q) || n.contentMd.toLowerCase().includes(q));
  }, [store.visible, store.notes, scoped, memberIds, query]);

  const createNote = async () => {
    const note = await store.create();
    if (projectId) await addMember(projectId, "note", note.id);
    else if (areaId) await addAreaMember(areaId, "note", note.id);
    nav.openNote(note.id);
  };

  const bar = scoped ? null : (
    <NavBar
      title="Notes"
      right={<NavAction icon="plus" label="New note" onPress={() => void createNote()} />}
      segments={
        <ListFilterTabs
          value={store.filter}
          onChange={store.setFilter}
          options={[
            { value: "unsorted", label: "Unsorted" },
            { value: "all", label: "All" },
          ]}
        />
      }
    />
  );

  if (store.loading) {
    return (
      <View style={styles.container}>
        {bar}
        <Spinner label="Loading your notes…" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {bar}
      <TourAnchor id={scoped ? "notes.scoped" : "notes.list"} style={styles.body}>
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
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <EmptyCaption>
            {query
              ? "No notes match that."
              : scoped
                ? `No notes in this ${areaId ? "area" : "project"} yet. Tap + to add one.`
                : "Nothing here yet. Tap + to start a note."}
          </EmptyCaption>
        }
        renderItem={({ item, index }) => (
          <GroupedItem index={index} count={notes.length}>
            <CardRow
              leading={<RowIcon name="file" />}
              separatorInset={ROW_ICON_INSET}
              title={item.title || "Untitled"}
              subtitle={notePreview(item)}
              trailing={
                <Text variant="mono" tone="tertiary">
                  {relTime(item.updatedAt)}
                </Text>
              }
              isLast={index === notes.length - 1}
              onPress={() => nav.openNote(item.id)}
            />
          </GroupedItem>
        )}
      />
      </TourAnchor>
      <Fab label="New note" onPress={() => void createNote()} />
    </View>
  );
}

export function TasksListScreen({ projectId, areaId }: { projectId?: string; areaId?: string }) {
  const store = useTasks();
  const nav = useNav();
  const { addMember, addAreaMember } = useProjects();
  const memberIds = useMemberIds(projectId, "task", areaId);
  const scoped = !!(projectId || areaId);

  // Project-scoped lists don't use the global Unsorted/All filter; they carry their own
  // schedule filter (all / anytime / upcoming / overdue / someday) instead.
  const [dueFilter, setDueFilter] = useState<"all" | ScheduleFilter>("all");
  const mode = scoped ? dueFilter : store.filter;

  const tasks = useMemo(() => {
    if (!scoped) return store.visible; // the global list honours the store's filter
    if (!memberIds) return [];
    const members = store.tasks.filter((t) => memberIds.has(t.id));
    // An area rolls up its projects' tasks, so the ones in a Someday project are filed away
    // with it; a project's own list shows its tasks whatever the project's state.
    const filedAway = areaId ? store.somedayIds : undefined;
    return dueFilter === "all" ? withoutSomeday(members, filedAway) : filterBySchedule(members, dueFilter, filedAway);
  }, [store.visible, store.tasks, store.somedayIds, scoped, memberIds, dueFilter, areaId]);

  // Upcoming and Overdue read as date groups (PLAN-scheduling.md §5): each a heading over its
  // own card of rows. Every other view is one card.
  const rows = useMemo<TaskListRow[]>(() => {
    const groups = scheduleGroups(tasks, mode) ?? [{ key: "all", label: "", items: tasks }];
    return groups.flatMap((g) => [
      ...(g.label ? [{ kind: "heading" as const, key: g.key, label: g.label, count: g.items.length }] : []),
      ...g.items.map((task, index) => ({ kind: "task" as const, key: task.id, task, index, count: g.items.length })),
    ]);
  }, [tasks, mode]);

  const createTask = async () => {
    // A task added from a schedule view lands in it: Someday, tomorrow (Upcoming), today (Overdue).
    const task = await store.create({ title: UNTITLED.task, ...newTaskDefaults(mode) });
    if (projectId) await addMember(projectId, "task", task.id);
    else if (areaId) await addAreaMember(areaId, "task", task.id);
    nav.openTask(task.id);
  };

  const bar = scoped ? (
    // The project screen's bar holds the section switcher; this list's own due filter
    // continues that bar as a second segmented row.
    <View style={styles.subBar}>
      <ListFilterTabs
        scroll
        value={dueFilter}
        onChange={setDueFilter}
        options={[
          { value: "all", label: "All" },
          { value: "anytime", label: "Anytime" },
          { value: "upcoming", label: "Upcoming" },
          { value: "overdue", label: "Overdue" },
          { value: "someday", label: "Someday" },
        ]}
      />
    </View>
  ) : (
    <NavBar
      title="Tasks"
      right={<NavAction icon="plus" label="New task" onPress={() => void createTask()} />}
      segments={
        <TourAnchor id="tasks.filters">
        <ListFilterTabs
          scroll
          value={store.filter}
          onChange={store.setFilter}
          options={[
            { value: "unsorted", label: "Unsorted" },
            { value: "all", label: "All" },
            { value: "anytime", label: "Anytime" },
            { value: "upcoming", label: "Upcoming" },
            { value: "overdue", label: "Overdue" },
            { value: "someday", label: "Someday" },
          ]}
        />
        </TourAnchor>
      }
    />
  );

  const taskRow = ({ task: item, index, count }: Extract<TaskListRow, { kind: "task" }>) => (
    <GroupedItem index={index} count={count}>
      <CardRow
        leading={
          <Checkbox
            checked={item.status === "done"}
            onPress={() => void store.setStatus(item.id, item.status === "done" ? "open" : "done")}
          />
        }
        separatorInset={CHECKBOX_INSET}
        title={item.title || "Untitled task"}
        subtitle={dueLabel(item)}
        showChevron={false}
        isLast={index === count - 1}
        onPress={() => nav.openTask(item.id)}
      />
    </GroupedItem>
  );

  if (store.loading) {
    return (
      <View style={styles.container}>
        {bar}
        <Spinner label="Loading your tasks…" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {bar}
      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        contentContainerStyle={[styles.list, styles.listTop]}
        ListEmptyComponent={<EmptyCaption>{emptyTasksCaption(mode, areaId ? "area" : projectId ? "project" : null)}</EmptyCaption>}
        renderItem={({ item: row }) => (row.kind === "heading" ? <DateGroupHeading label={row.label} count={row.count} /> : taskRow(row))}
      />
      <Fab label="New task" anchor={scoped ? undefined : "tasks.new"} onPress={() => void createTask()} />
    </View>
  );
}

/** One row of the task list: a date-group heading, or a task with its place in its card. */
type TaskListRow =
  | { kind: "heading"; key: string; label: string; count: number }
  | { kind: "task"; key: string; task: Task; index: number; count: number };

function emptyTasksCaption(mode: string, where: "area" | "project" | null): string {
  const here = where ? ` in this ${where}` : "";
  switch (mode) {
    case "anytime":
      return `No tasks without a start or a deadline${here}.`;
    case "upcoming":
      return where ? `No upcoming tasks${here}.` : "Nothing coming up.";
    case "overdue":
      return where ? `No overdue tasks${here}.` : "Nothing overdue.";
    case "someday":
      return `Nothing filed under Someday${here}.`;
    default:
      return where ? `No tasks${here} yet. Tap + to add one.` : "Nothing to do. Tap + to add a task.";
  }
}

function notePreview(n: Note): string {
  const body = n.contentMd.replace(/\s+/g, " ").trim();
  return body || "No additional text";
}

// The row subtitle: the deadline, else a start still ahead, else nothing to show.
function dueLabel(task: Task): string {
  if (task.status === "done") return "Completed";
  if (task.someday) return "Someday";
  const short = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (task.dueAt && !Number.isNaN(new Date(task.dueAt).getTime())) return "Due " + short(task.dueAt);
  if (task.startAt && new Date(task.startAt).getTime() > Date.now()) return "Starts " + short(task.startAt);
  return "No deadline";
}

// Compact relative time (e.g. "2h", "3d") for the row's trailing metadata.
function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return "now";
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
  subBar: {
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.surfaceApp,
  },
  // The notes list under the bar (search and rows): what the notes tutorial points at.
  body: { flex: 1, minHeight: 0 },
  search: { paddingHorizontal: space.ml, paddingTop: space.ml, paddingBottom: space.md },
  list: { paddingHorizontal: space.ml, paddingBottom: FAB_CLEARANCE, flexGrow: 1 },
  listTop: { paddingTop: space.ml },
});
