import { useMemo, useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { List, ListItem, Task } from "@companion/core-bridge";
import { Icon, IconButton, Input, Text, colors, space } from "@companion/design-system";
import { useNav } from "../nav-context";
import { useTasks } from "../TasksProvider";
import { useLists, useListItems, useProjectLists } from "../ListsProvider";
import { SortableList } from "../SortableList";
import { Checkbox } from "../TaskEditor";
import { AddTasksPicker } from "../AddTasksPicker";
import { useMemberIds } from "./ListScreens";
import { CardRow, Fab } from "./ui";

// Lists for the mobile web shell (PLAN §6.6): a project's Lists tab shows its lists; tapping
// one drills into its rows (/project/<id>/lists/<listId>), where tasks reorder by dragging
// the ☰ handle and tapping a task opens the full-screen editor.

export function ListsIndexScreen({ projectId }: { projectId: string }) {
  const nav = useNav();
  const lists = useProjectLists(projectId);
  const { createList } = useLists();
  const [draft, setDraft] = useState<string | null>(null);

  const submit = async () => {
    const name = draft?.trim();
    setDraft(null);
    if (!name) return;
    const list = await createList(projectId, name);
    nav.openProjectItem(projectId, "lists", list.id);
  };

  return (
    <View style={styles.container}>
      {draft !== null ? (
        <View style={styles.search}>
          <Input size="sm" placeholder="List name, press Enter" value={draft} onChangeText={setDraft} autoFocus onSubmitEditing={() => void submit()} onBlur={() => void submit()} />
        </View>
      ) : null}
      <FlatList
        data={lists}
        keyExtractor={(l) => l.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text tone="tertiary" style={styles.empty}>
            No lists yet. Tap + to order this project’s tasks by priority.
          </Text>
        }
        renderItem={({ item }) => <ListCard list={item} onPress={() => nav.openProjectItem(projectId, "lists", item.id)} />}
      />
      <Fab label="New list" onPress={() => setDraft("")} />
    </View>
  );
}

function ListCard({ list, onPress }: { list: List; onPress: () => void }) {
  const items = useListItems(list.id);
  const count = items.filter((i) => i.kind === "task").length;
  return (
    <CardRow
      leading={<Icon name="listOrdered" size={19} color={colors.textTertiary} />}
      title={list.name}
      subtitle={count === 1 ? "1 task" : `${count} tasks`}
      divided={false}
      onPress={onPress}
    />
  );
}

export function ListRowsScreen({ projectId, listId }: { projectId: string; listId: string }) {
  const nav = useNav();
  const tasksStore = useTasks();
  const lists = useProjectLists(projectId);
  const items = useListItems(listId);
  const { createTask, addTasks, addHeading, removeItem, reorderItems, renameList } = useLists();
  const memberIds = useMemberIds(projectId, "task");
  const [taskDraft, setTaskDraft] = useState("");
  const [headingDraft, setHeadingDraft] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const list = lists.find((l) => l.id === listId);
  // The title reads as a heading; tapping it swaps in a field to rename (commits on blur/Enter).
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const commitName = () => {
    const name = nameDraft?.trim();
    setNameDraft(null);
    if (list && name && name !== list.name) void renameList(list.id, name);
  };

  // The project's open tasks not yet in this list — the "add existing" picker's candidates.
  const candidates = useMemo(() => {
    if (!memberIds) return [];
    const inList = new Set(items.filter((i) => i.taskId).map((i) => i.taskId as string));
    return tasksStore.tasks.filter((t) => memberIds.has(t.id) && !inList.has(t.id) && t.status !== "done");
  }, [memberIds, items, tasksStore.tasks]);

  const rows = items
    .map((item) => ({ item, task: item.kind === "task" && item.taskId ? tasksStore.byId(item.taskId) : undefined }))
    .filter((r) => r.item.kind === "heading" || r.task);

  const addTaskFromDraft = async () => {
    const title = taskDraft.trim();
    setTaskDraft("");
    if (title) await createTask(listId, title);
  };
  const addHeadingFromDraft = async () => {
    const title = headingDraft?.trim();
    setHeadingDraft(null);
    if (title) await addHeading(listId, title);
  };

  return (
    <View style={styles.container}>
      <View style={styles.titleRow}>
        <IconButton label="Back to lists" size="sm" onPress={() => nav.openProjectSection(projectId, "lists")}>
          <Icon name="chevronLeft" size={18} color={colors.textSecondary} />
        </IconButton>
        {nameDraft !== null ? (
          <View style={{ flex: 1 }}>
            <Input size="sm" value={nameDraft} placeholder="List name" autoFocus onChangeText={setNameDraft} onSubmitEditing={commitName} onBlur={commitName} />
          </View>
        ) : (
          <Pressable style={{ flex: 1, minWidth: 0 }} onPress={() => setNameDraft(list?.name ?? "")} aria-label="Rename list">
            <Text variant="title" numberOfLines={1}>
              {list?.name ?? "List"}
            </Text>
          </Pressable>
        )}
        <IconButton label="Add existing task" size="sm" active={picking} onPress={() => setPicking(true)}>
          <Icon name="tasks" size={16} color={colors.textSecondary} />
        </IconButton>
        <IconButton label="New heading" size="sm" active={headingDraft !== null} onPress={() => setHeadingDraft((d) => (d === null ? "" : null))}>
          <Icon name="listBullet" size={16} color={colors.textSecondary} />
        </IconButton>
      </View>
      {/* One entry field: the heading field temporarily takes the task field's place. */}
      <View style={styles.search}>
        {headingDraft !== null ? (
          <Input
            size="sm"
            placeholder="Heading, press Enter"
            value={headingDraft}
            onChangeText={setHeadingDraft}
            autoFocus
            onSubmitEditing={() => void addHeadingFromDraft()}
            onBlur={() => void addHeadingFromDraft()}
            leadingIcon={<Icon name="listBullet" size={15} color={colors.textTertiary} />}
          />
        ) : (
          <Input
            size="sm"
            placeholder="Add a task, press Enter"
            value={taskDraft}
            onChangeText={setTaskDraft}
            onSubmitEditing={() => void addTaskFromDraft()}
            leadingIcon={<Icon name="plus" size={15} color={colors.textTertiary} />}
          />
        )}
      </View>
      {/* activateOnStart claims the ☰ handle's touch before the scroll view can. */}
      <ScrollView contentContainerStyle={styles.list}>
        {rows.length ? (
            <SortableList
              items={rows}
              keyExtractor={(r) => r.item.id}
              onReorder={(ids) => void reorderItems(listId, ids)}
              activateOnStart
              renderItem={({ item: r, drag }) =>
                r.item.kind === "heading" ? (
                  <View style={styles.headingRow}>
                    <View {...drag} style={styles.handle}>
                      <Icon name="moreH" size={18} color={colors.textTertiary} />
                    </View>
                    <Text variant="mono" numberOfLines={1} style={styles.headingLabel}>
                      {(r.item.title || "Untitled").toUpperCase()}
                    </Text>
                    <IconButton label="Remove heading" size="sm" onPress={() => void removeItem(r.item.id)}>
                      <Icon name="close" size={13} color={colors.textTertiary} />
                    </IconButton>
                  </View>
                ) : (
                  <TaskCard task={r.task as Task} item={r.item} drag={drag} onRemove={() => void removeItem(r.item.id)} />
                )
              }
            />
        ) : (
          <Text tone="tertiary" style={styles.empty}>
            This list is empty. Type a task above, then drag ☰ to set priority.
          </Text>
        )}
      </ScrollView>
      {picking ? <AddTasksPicker candidates={candidates} onAdd={(ids) => addTasks(listId, ids)} onClose={() => setPicking(false)} /> : null}
    </View>
  );
}

function TaskCard({ task, drag, onRemove }: { task: Task; item: ListItem; drag: object; onRemove: () => void }) {
  const nav = useNav();
  const store = useTasks();
  return (
    <CardRow
      leading={
        <View style={styles.leading}>
          <View {...drag} style={styles.handle}>
            <Icon name="moreH" size={18} color={colors.textTertiary} />
          </View>
          <Checkbox checked={task.status === "done"} onPress={() => void store.setStatus(task.id, task.status === "done" ? "open" : "done")} size={22} />
        </View>
      }
      title={task.title || "Untitled task"}
      trailing={
        <IconButton label="Remove from list" size="sm" onPress={onRemove}>
          <Icon name="close" size={13} color={colors.textTertiary} />
        </IconButton>
      }
      showChevron={false}
      divided={false}
      onPress={() => nav.openTask(task.id)}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surfaceApp },
  titleRow: { flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.sm, paddingTop: space.sm, minHeight: 40 },
  search: { paddingHorizontal: space.md, paddingTop: space.sm },
  list: { paddingHorizontal: space.md, paddingVertical: space.sm, gap: 2, flexGrow: 1 },
  empty: { textAlign: "center", marginTop: space.xxl },
  // Inset so the heading's handle lines up with the task rows' (CardRow pads by space.xl;
  // the task handle sits space.sm back from that via `leading`).
  headingRow: { flexDirection: "row", alignItems: "center", paddingLeft: space.xl - space.sm, paddingRight: space.xs, paddingTop: space.md },
  headingLabel: { flex: 1, fontSize: 10, letterSpacing: 1.2, color: colors.textTertiary, paddingHorizontal: space.sm },
  leading: { flexDirection: "row", alignItems: "center", gap: space.xs, marginLeft: -space.sm },
  handle: { paddingHorizontal: space.sm, paddingVertical: space.sm },
});
