import { useEffect, useMemo, useState } from "react";
import { FlatList, ScrollView, StyleSheet, View } from "react-native";
import type { Note, Task } from "@companion/core-bridge";
import { Icon, Input, Spinner, Text, colors, space } from "@companion/design-system";
import { useNav } from "../nav-context";
import { useCore } from "../CoreContext";
import { useNotes } from "../NotesProvider";
import { useTasks, filterTasksByDue } from "../TasksProvider";
import { useProjects } from "../ProjectsProvider";
import { ListFilterTabs } from "../ListFilterMenu";
import { Checkbox } from "../TaskEditor";
import { CardRow, Fab } from "./ui";

// Full-screen browse lists for the mobile web shell — ports of the native app's
// NotesListScreen/TasksListScreen. Used globally (all items) and inside the project
// screen, where `projectId` scopes the list to the project's members and makes new
// items members of it (PLAN §6.6). Tapping a row pushes the full-screen editor.

/** Tracks a project's member ids of one entity type, refreshed as memberships change. */
function useMemberIds(projectId: string | undefined, entityType: "note" | "task"): Set<string> | null {
  const { core } = useCore();
  const { membershipsForProject } = useProjects();
  const [memberIds, setMemberIds] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!projectId) {
      setMemberIds(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      const rows = await membershipsForProject(projectId);
      if (!cancelled) setMemberIds(new Set(rows.filter((m) => m.entityType === entityType).map((m) => m.entityId)));
    };
    void load();
    const off = core.on("nav.changed", () => void load());
    return () => {
      cancelled = true;
      off();
    };
  }, [projectId, entityType, membershipsForProject, core]);
  return memberIds;
}

export function NotesListScreen({ projectId }: { projectId?: string }) {
  const store = useNotes();
  const nav = useNav();
  const { addMember } = useProjects();
  const memberIds = useMemberIds(projectId, "note");
  const [query, setQuery] = useState("");

  const notes = useMemo(() => {
    const base = !projectId
      ? store.visible // global list honours the Unsorted/All filter
      : !memberIds
        ? []
        : store.notes.filter((n) => memberIds.has(n.id));
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter((n) => n.title.toLowerCase().includes(q) || n.contentMd.toLowerCase().includes(q));
  }, [store.visible, store.notes, projectId, memberIds, query]);

  const createNote = async () => {
    const note = await store.create();
    if (projectId) await addMember(projectId, "note", note.id);
    nav.openNote(note.id);
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
              { value: "unsorted", label: "Unsorted" },
              { value: "all", label: "All" },
            ]}
          />
        </View>
      ) : null}
      <View style={styles.search}>
        <Input
          size="sm"
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
          <Text tone="tertiary" style={styles.empty}>
            {query
              ? "No notes match that."
              : projectId
                ? "No notes in this project yet. Tap + to add one."
                : "Nothing here yet. Tap + to start a note."}
          </Text>
        }
        renderItem={({ item }) => (
          <CardRow
            leading={<Icon name="file" size={19} color={colors.textTertiary} />}
            title={item.title || "Untitled"}
            subtitle={notePreview(item)}
            trailing={
              <Text variant="mono" tone="tertiary" style={styles.time}>
                {relTime(item.updatedAt)}
              </Text>
            }
            divided={false}
            onPress={() => nav.openNote(item.id)}
          />
        )}
      />
      <Fab label="New note" onPress={() => void createNote()} />
    </View>
  );
}

export function TasksListScreen({ projectId }: { projectId?: string }) {
  const store = useTasks();
  const nav = useNav();
  const { addMember } = useProjects();
  const memberIds = useMemberIds(projectId, "task");

  // Project-scoped lists don't use the global Unsorted/All filter; they carry their own
  // due-date filter (all / upcoming / overdue) instead.
  const [dueFilter, setDueFilter] = useState<"all" | "upcoming" | "overdue">("all");

  const tasks = useMemo(() => {
    if (!projectId) return store.visible; // global list honours the Unsorted/All/Upcoming/Overdue filter
    if (!memberIds) return [];
    const members = store.tasks.filter((t) => memberIds.has(t.id));
    return dueFilter === "all" ? members : filterTasksByDue(members, dueFilter);
  }, [store.visible, store.tasks, projectId, memberIds, dueFilter]);

  const createTask = async () => {
    const task = await store.create({ title: "Untitled task" });
    if (projectId) await addMember(projectId, "task", task.id);
    nav.openTask(task.id);
  };

  if (store.loading) {
    return <Spinner label="Loading your tasks…" />;
  }

  return (
    <View style={styles.container}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterBar} contentContainerStyle={styles.filterBarContent}>
        {!projectId ? (
          <ListFilterTabs
            value={store.filter}
            onChange={store.setFilter}
            options={[
              { value: "unsorted", label: "Unsorted" },
              { value: "all", label: "All" },
              { value: "upcoming", label: "Upcoming" },
              { value: "overdue", label: "Overdue" },
            ]}
          />
        ) : (
          <ListFilterTabs
            value={dueFilter}
            onChange={setDueFilter}
            options={[
              { value: "all", label: "All" },
              { value: "upcoming", label: "Upcoming" },
              { value: "overdue", label: "Overdue" },
            ]}
          />
        )}
      </ScrollView>
      <FlatList
        data={tasks}
        keyExtractor={(t) => t.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text tone="tertiary" style={styles.empty}>
            {projectId
              ? dueFilter === "upcoming"
                ? "No upcoming tasks in this project."
                : dueFilter === "overdue"
                  ? "No overdue tasks in this project."
                  : "No tasks in this project yet. Tap + to add one."
              : "Nothing to do. Tap + to add a task."}
          </Text>
        }
        renderItem={({ item }) => (
          <CardRow
            leading={
              <Checkbox
                checked={item.status === "done"}
                onPress={() => void store.setStatus(item.id, item.status === "done" ? "open" : "done")}
                size={22}
              />
            }
            title={item.title || "Untitled task"}
            subtitle={dueLabel(item)}
            showChevron={false}
            divided={false}
            onPress={() => nav.openTask(item.id)}
          />
        )}
      />
      <Fab label="New task" onPress={() => void createTask()} />
    </View>
  );
}

function notePreview(n: Note): string {
  const body = n.contentMd.replace(/\s+/g, " ").trim();
  return body || "No additional text";
}

function dueLabel(task: Task): string {
  if (task.status === "done") return "Completed";
  if (!task.dueAt) return "No due date";
  const d = new Date(task.dueAt);
  if (Number.isNaN(d.getTime())) return "No due date";
  return "Due " + d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
  filterBar: { paddingTop: space.sm, flexGrow: 0 },
  filterBarContent: { paddingHorizontal: space.md },
  search: { paddingHorizontal: space.md, paddingTop: space.sm },
  list: { paddingHorizontal: space.md, paddingVertical: space.sm, gap: 2, flexGrow: 1 },
  time: { fontSize: 11 },
  empty: { textAlign: "center", marginTop: space.xxl },
});
