import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { List, ListItem, Task } from "@companion/core-bridge";
import { Icon, IconButton, Input, Text, colors, row, space } from "@companion/design-system";
import { useNav } from "../nav-context";
import { useTasks } from "../TasksProvider";
import { useLists, useListItems, useProjectLists } from "../ListsProvider";
import { SortableList } from "../SortableList";
import { AddTasksPicker } from "../AddTasksPicker";
import { useMemberIds } from "./ListScreens";
import { Card, CardRow, Checkbox, EmptyCaption, FAB_CLEARANCE, Fab, NavAction, NavBar, ROW_ICON_INSET, RowIcon, cardStyle } from "./ui";

// Lists for the mobile web shell (PLAN §6.6): a project's Lists tab shows its lists; tapping
// one drills into its rows (/project/<id>/lists/<listId>), where tasks reorder by dragging
// the ☰ handle and tapping a task opens the full-screen editor. The index renders bare
// inside the project screen (which owns the nav bar); a list's rows are their own route
// and bring their own bar — the title renames on tap, and its actions are bar icons.

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
        <View style={styles.entry}>
          <Input placeholder="Name the list, press Enter" value={draft} onChangeText={setDraft} autoFocus onSubmitEditing={() => void submit()} onBlur={() => void submit()} />
        </View>
      ) : null}
      <ScrollView contentContainerStyle={styles.list}>
        {lists.length ? (
          <Card>
            {lists.map((l, i) => (
              <ListCard key={l.id} list={l} isLast={i === lists.length - 1} onPress={() => nav.openProjectItem(projectId, "lists", l.id)} />
            ))}
          </Card>
        ) : (
          <EmptyCaption>No lists yet. Tap + to order this project’s tasks by priority.</EmptyCaption>
        )}
      </ScrollView>
      <Fab label="New list" onPress={() => setDraft("")} />
    </View>
  );
}

function ListCard({ list, isLast, onPress }: { list: List; isLast: boolean; onPress: () => void }) {
  const items = useListItems(list.id);
  const count = items.filter((i) => i.kind === "task").length;
  return (
    <CardRow
      leading={<RowIcon name="listOrdered" />}
      separatorInset={ROW_ICON_INSET}
      title={list.name}
      subtitle={count === 1 ? "1 task" : `${count} tasks`}
      isLast={isLast}
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

  // Back returns to the project's Lists tab; a deep link has no history, so step up.
  const back = () => (nav.canBack ? nav.back() : nav.openProjectSection(projectId, "lists"));

  return (
    <View style={styles.container}>
      <NavBar
        title={list?.name ?? "List"}
        onBack={back}
        titleSlot={
          nameDraft !== null ? (
            <View style={styles.titleSlot}>
              <Input value={nameDraft} placeholder="Name the list" autoFocus onChangeText={setNameDraft} onSubmitEditing={commitName} onBlur={commitName} />
            </View>
          ) : (
            <Pressable style={styles.titleSlot} onPress={() => setNameDraft(list?.name ?? "")} aria-label="Rename list">
              <Text variant="title" numberOfLines={1}>
                {list?.name ?? "List"}
              </Text>
            </Pressable>
          )
        }
        right={
          <>
            <NavAction icon="tasks" label="Add existing task" active={picking} onPress={() => setPicking(true)} />
            <NavAction icon="listBullet" label="New heading" active={headingDraft !== null} onPress={() => setHeadingDraft((d) => (d === null ? "" : null))} />
          </>
        }
      />
      {/* One entry field: the heading field temporarily takes the task field's place. */}
      <View style={styles.entry}>
        {headingDraft !== null ? (
          <Input
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
            style={cardStyle()}
            items={rows}
            keyExtractor={(r) => r.item.id}
            onReorder={(ids) => void reorderItems(listId, ids)}
            activateOnStart
            renderItem={({ item: r, index, drag }) =>
              r.item.kind === "heading" ? (
                <View style={[styles.headingRow, index === rows.length - 1 ? null : styles.rowDivider]}>
                  <View {...drag} style={styles.handle}>
                    <Icon name="moreH" size={18} color={colors.textTertiary} />
                  </View>
                  <Text variant="eyebrow" tone="tertiary" numberOfLines={1} style={styles.headingLabel}>
                    {r.item.title || "Untitled"}
                  </Text>
                  <IconButton label="Remove heading" onPress={() => void removeItem(r.item.id)}>
                    <Icon name="close" size={14} color={colors.textTertiary} />
                  </IconButton>
                </View>
              ) : (
                <TaskCard task={r.task as Task} item={r.item} drag={drag} isLast={index === rows.length - 1} onRemove={() => void removeItem(r.item.id)} />
              )
            }
          />
        ) : (
          <EmptyCaption>This list is empty. Type a task above, then drag ☰ to set priority.</EmptyCaption>
        )}
      </ScrollView>
      {picking ? <AddTasksPicker candidates={candidates} onAdd={(ids) => addTasks(listId, ids)} onClose={() => setPicking(false)} /> : null}
    </View>
  );
}

function TaskCard({ task, drag, isLast, onRemove }: { task: Task; item: ListItem; drag: object; isLast: boolean; onRemove: () => void }) {
  const nav = useNav();
  const store = useTasks();
  return (
    <CardRow
      leading={
        <View style={styles.leading}>
          <View {...drag} style={styles.handle}>
            <Icon name="moreH" size={18} color={colors.textTertiary} />
          </View>
          <Checkbox checked={task.status === "done"} onPress={() => void store.setStatus(task.id, task.status === "done" ? "open" : "done")} />
        </View>
      }
      separatorInset={space.xl}
      title={task.title || "Untitled task"}
      trailing={
        <IconButton label="Remove from list" onPress={onRemove}>
          <Icon name="close" size={14} color={colors.textTertiary} />
        </IconButton>
      }
      showChevron={false}
      isLast={isLast}
      onPress={() => nav.openTask(task.id)}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surfaceApp },
  titleSlot: { flex: 1, minWidth: 0 },
  entry: { paddingHorizontal: space.ml, paddingTop: space.ml },
  list: { paddingHorizontal: space.ml, paddingTop: space.ml, paddingBottom: FAB_CLEARANCE, flexGrow: 1 },
  // Inset so the heading's handle lines up with the task rows' (CardRow pads by space.xl;
  // the task handle sits space.sm back from that via `leading`).
  headingRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: row.touch,
    paddingLeft: space.xl - space.sm,
    paddingRight: space.lg,
    backgroundColor: colors.surfaceSunken,
  },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  headingLabel: { flex: 1, minWidth: 0, paddingHorizontal: space.sm },
  leading: { flexDirection: "row", alignItems: "center", gap: space.xs, marginLeft: -space.sm },
  handle: { paddingHorizontal: space.sm, paddingVertical: space.sm },
});
