import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View, type GestureResponderHandlers } from "react-native";
import type { List, ListItem, Task } from "@companion/core-bridge";
import { Button, Center, Icon, IconButton, Input, ListRow, Text, TextField, colors, icon, layout, radius, space } from "@companion/design-system";
import { useNav } from "./nav-context";
import { useTasks } from "./TasksProvider";
import { useLists, useListItems, useProjectLists } from "./ListsProvider";
import { ListFilterMenu } from "./ListFilterMenu";
import { SortableList } from "./SortableList";
import { DragGrip } from "./DragGrip";
import { ListSectionFold } from "./ListSectionFold";
import { useDropTarget } from "./DndContext";
import { TaskRow } from "./TaskEditor";
import { ConfirmDialog } from "./ConfirmDialog";
import { AddTasksPicker } from "./AddTasksPicker";

// The Lists section of a project (PLAN §6.6): drag-ordered task lists, each optionally
// broken into sublists by headings. Lives in the project's list column (under the section
// chips); the selected list's rows replace the index, and selecting a task opens it in the
// detail pane. Same density as the workspace browse lists. Routes:
//   /project/<id>/lists                 → the lists index (ListsIndex)
//   /project/<id>/lists/<listId>        → that list's rows (ListRows)
//   /project/<id>/lists/<listId>/<task> → same, with the task open in the detail pane

/** The column body for the lists section: the index of lists, or one list's rows. */
export function ListsColumn({ projectId, listId, selectedTaskId, projectTasks }: { projectId: string; listId?: string; selectedTaskId?: string; projectTasks: Task[] }) {
  if (listId) return <ListRows projectId={projectId} listId={listId} selectedTaskId={selectedTaskId} projectTasks={projectTasks} />;
  return <ListsIndex projectId={projectId} />;
}

/** Level 1: the project's lists, drag-reorderable, each a drop target for dragged tasks. */
function ListsIndex({ projectId }: { projectId: string }) {
  const nav = useNav();
  const lists = useProjectLists(projectId);
  const { createList, reorderLists } = useLists();
  const [draft, setDraft] = useState<string | null>(null);

  const submit = async () => {
    const name = draft?.trim();
    setDraft(null);
    if (!name) return;
    const list = await createList(projectId, name);
    nav.openProjectItem(projectId, "lists", list.id);
  };

  return (
    <View style={styles.list}>
      <View style={styles.listHeader}>
        <Text variant="label" numberOfLines={1} style={{ flex: 1 }}>
          Lists
        </Text>
        <Text variant="mono" tone="quaternary">
          {lists.length}
        </Text>
        <IconButton label="New list" size="sm" active={draft !== null} onPress={() => setDraft((d) => (d === null ? "" : null))}>
          <Icon name="plus" size={icon.sm} color={colors.textSecondary} />
        </IconButton>
      </View>
      {draft !== null ? (
        <View style={styles.search}>
          {/* Commit on blur (click away), as the sidebar's create inputs do; an empty value just closes. */}
          <Input
            size="sm"
            placeholder="List name, press Enter"
            value={draft}
            onChangeText={setDraft}
            autoFocus
            onSubmitEditing={() => void submit()}
            onBlur={() => void submit()}
            leadingIcon={<Icon name="listOrdered" size={icon.sm} color={colors.textQuaternary} />}
          />
        </View>
      ) : null}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scroll}>
        {lists.length ? (
          <SortableList
            style={styles.rows}
            items={lists}
            keyExtractor={(l) => l.id}
            onReorder={(ids) => void reorderLists(projectId, ids)}
            // Rows reorder from the grip at their far right, which claims the drag on press.
            activateOnStart
            renderItem={({ item, isActive, drag }) => (
              <ListIndexRow list={item} dragging={isActive} drag={drag} onPress={() => nav.openProjectItem(projectId, "lists", item.id)} />
            )}
          />
        ) : (
          <Text tone="tertiary" variant="caption" style={styles.empty}>
            No lists yet. Add one with ＋ to order this project’s tasks by priority.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

function ListIndexRow({ list, dragging, drag, onPress }: { list: List; dragging: boolean; drag: GestureResponderHandlers; onPress: () => void }) {
  const { addTask } = useLists();
  const items = useListItems(list.id);
  // Dropping a dragged task on a list appends it (and joins the project if needed).
  const { ref, isOver } = useDropTarget(`list:${list.id}`, (p) => {
    if (p.kind === "task") void addTask(list.id, p.id);
  });
  const taskCount = items.filter((i) => i.kind === "task").length;
  return (
    <View ref={ref} style={[dragging ? styles.rowDragging : null, isOver ? styles.rowOver : null]}>
      <ListRow
        icon={<Icon name="listOrdered" size={icon.sm} color={isOver ? colors.textAccent : colors.textQuaternary} />}
        title={list.name}
        trailing={taskCount ? String(taskCount) : undefined}
        selected={isOver}
        hasChildren
        accessory={<DragGrip handlers={drag} label="Drag to reorder" />}
        onPress={onPress}
      />
    </View>
  );
}

/** Level 2: one list's rows. Tasks and headings share one drag order, so dragging a task
 *  under a heading files it in that sublist. */
function ListRows({ projectId, listId, selectedTaskId, projectTasks }: { projectId: string; listId: string; selectedTaskId?: string; projectTasks: Task[] }) {
  const nav = useNav();
  const tasksStore = useTasks();
  const lists = useProjectLists(projectId);
  const items = useListItems(listId);
  const { addTasks, createTask, addHeading, renameHeading, removeItem, reorderItems } = useLists();
  const [taskDraft, setTaskDraft] = useState("");
  const [headingDraft, setHeadingDraft] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  // Resolve task rows against the live task store; rows whose task is trashed or not yet
  // synced simply don't render (the row itself is kept so a restore brings it back).
  const rows = useMemo(
    () =>
      items
        .map((item) => ({ item, task: item.kind === "task" && item.taskId ? tasksStore.byId(item.taskId) : undefined }))
        .filter((r) => r.item.kind === "heading" || r.task),
    [items, tasksStore],
  );
  // Completed tasks leave the drag order for their own folded section at the foot (as in the
  // plain task lists, §6.4); headings and open tasks keep the hierarchy to themselves.
  const active = useMemo(() => rows.filter((r) => r.task?.status !== "done"), [rows]);
  const done = useMemo(() => rows.filter((r) => r.task?.status === "done"), [rows]);
  // A drag reorders the active rows only. Completed rows keep their slots in the full order,
  // so reopening one returns it to where it sat rather than to wherever the drag left a gap.
  const reorderActive = (ids: string[]) => {
    const next = [...ids];
    const held = new Set(done.map((r) => r.item.id));
    return reorderItems(listId, rows.map((r) => (held.has(r.item.id) ? r.item.id : (next.shift() ?? r.item.id))));
  };
  const inList = useMemo(() => new Set(items.filter((i) => i.taskId).map((i) => i.taskId as string)), [items]);
  // Project tasks not yet in this list — the "add existing" picker's candidates.
  const candidates = useMemo(() => projectTasks.filter((t) => !inList.has(t.id) && t.status !== "done"), [projectTasks, inList]);

  // The header dropdown switches between this project's lists, or back to the plain tasks list.
  const switchOptions = useMemo(
    () => [...lists.map((l) => ({ value: l.id, label: l.name })), { value: "__tasks", label: "All tasks" }],
    [lists],
  );

  const addTaskFromDraft = async () => {
    const title = taskDraft.trim();
    setTaskDraft("");
    if (!title) return;
    const task = await createTask(listId, title);
    nav.openProjectSubItem(projectId, "lists", listId, task.id);
  };
  const addHeadingFromDraft = async () => {
    const title = headingDraft?.trim();
    setHeadingDraft(null);
    if (title) await addHeading(listId, title);
  };

  return (
    <View style={styles.list}>
      <View style={styles.listHeader}>
        <IconButton label="Back to lists" size="sm" onPress={() => nav.openProjectSection(projectId, "lists")}>
          <Icon name="chevronLeft" size={13} color={colors.textSecondary} />
        </IconButton>
        <View style={{ flex: 1 }}>
          <ListFilterMenu
            value={listId}
            options={switchOptions}
            onChange={(v) => (v === "__tasks" ? nav.openProjectSection(projectId, "tasks") : nav.openProjectItem(projectId, "lists", v))}
          />
        </View>
        <IconButton label="Add existing task" size="sm" active={picking} onPress={() => setPicking(true)}>
          <Icon name="tasks" size={13} color={colors.textSecondary} />
        </IconButton>
        <IconButton label="New heading" size="sm" active={headingDraft !== null} onPress={() => setHeadingDraft((d) => (d === null ? "" : null))}>
          <Icon name="listBullet" size={13} color={colors.textSecondary} />
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
            leadingIcon={<Icon name="listBullet" size={icon.sm} color={colors.textQuaternary} />}
          />
        ) : (
          <Input
            size="sm"
            placeholder="Add a task, press Enter"
            value={taskDraft}
            onChangeText={setTaskDraft}
            onSubmitEditing={() => void addTaskFromDraft()}
            leadingIcon={<Icon name="plus" size={icon.sm} color={colors.textQuaternary} />}
          />
        )}
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scroll}>
        {active.length ? (
          <SortableList
            style={styles.rows}
            items={active}
            keyExtractor={(r) => r.item.id}
            onReorder={(ids) => void reorderActive(ids)}
            // Rows reorder from the grip at their far right, which claims the drag on press.
            activateOnStart
            renderItem={({ item: r, isActive, drag }) =>
              r.item.kind === "heading" ? (
                <HeadingRow item={r.item} dragging={isActive} drag={drag} onRename={(title) => void renameHeading(r.item.id, title)} onRemove={() => void removeItem(r.item.id)} />
              ) : (
                <View style={isActive ? styles.rowDragging : null}>
                  <TaskRow
                    task={r.task as Task}
                    selected={r.task?.id === selectedTaskId}
                    onPress={() => nav.openProjectSubItem(projectId, "lists", listId, (r.task as Task).id)}
                    onToggle={() => void tasksStore.setStatus((r.task as Task).id, "done")}
                    handle={<DragGrip handlers={drag} label="Drag to reorder" />}
                    trailing={
                      <IconButton label="Remove from list" size="sm" onPress={() => void removeItem(r.item.id)}>
                        <Icon name="close" size={icon.sm} color={colors.textQuaternary} />
                      </IconButton>
                    }
                  />
                </View>
              )
            }
          />
        ) : (
          <Text tone="tertiary" variant="caption" style={styles.empty}>
            {done.length
              ? "Everything in this list is done. Add a task above, or pull in existing project tasks."
              : "This list is empty. Add a task above, or pull in existing project tasks. Drag rows to set priority; headings group them."}
          </Text>
        )}
        {done.length ? (
          <ListSectionFold label={`Completed · ${done.length}`} storageKey="lists.completed" defaultOpen={false}>
            {done.map((r) => (
              <TaskRow
                key={r.item.id}
                task={r.task as Task}
                selected={r.task?.id === selectedTaskId}
                onPress={() => nav.openProjectSubItem(projectId, "lists", listId, (r.task as Task).id)}
                onToggle={() => void tasksStore.setStatus((r.task as Task).id, "open")}
                trailing={
                  <IconButton label="Remove from list" size="sm" onPress={() => void removeItem(r.item.id)}>
                    <Icon name="close" size={icon.sm} color={colors.textQuaternary} />
                  </IconButton>
                }
              />
            ))}
          </ListSectionFold>
        ) : null}
      </ScrollView>
      {picking ? <AddTasksPicker candidates={candidates} onAdd={(ids) => addTasks(listId, ids)} onClose={() => setPicking(false)} /> : null}
    </View>
  );
}

/** A heading row (sublist label). Press to rename inline; the ✕ removes the heading only —
 *  the tasks beneath it simply join the sublist above. */
function HeadingRow({
  item,
  dragging,
  drag,
  onRename,
  onRemove,
}: {
  item: ListItem;
  dragging: boolean;
  drag: GestureResponderHandlers;
  onRename: (title: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.title);
  useEffect(() => setDraft(item.title), [item.title]);
  const commit = () => {
    setEditing(false);
    const title = draft.trim();
    if (title && title !== item.title) onRename(title);
    else setDraft(item.title);
  };
  // The remove button only appears while the row is hovered (see TaskRow's trailing slot).
  const [hovered, setHovered] = useState(false);
  return (
    <View
      style={[styles.heading, dragging ? styles.rowDragging : null]}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      {editing ? (
        <View style={{ flex: 1 }}>
          <Input size="sm" value={draft} onChangeText={setDraft} autoFocus onSubmitEditing={commit} onBlur={commit} />
        </View>
      ) : (
        <Pressable onPress={() => setEditing(true)} style={{ flex: 1 }} aria-label="Rename heading">
          <Text variant="eyebrow" tone="quaternary" numberOfLines={1}>
            {item.title || "Untitled"}
          </Text>
        </Pressable>
      )}
      <View style={{ opacity: hovered ? 1 : 0 }}>
        <IconButton label="Remove heading" size="sm" onPress={onRemove}>
          <Icon name="close" size={icon.sm} color={colors.textQuaternary} />
        </IconButton>
      </View>
      <View style={{ opacity: hovered || dragging ? 1 : 0 }}>
        <DragGrip handlers={drag} label="Drag to reorder" />
      </View>
    </View>
  );
}

/** The detail pane for a list with no task selected: rename, a summary, and delete. */
export function ListHome({ projectId, listId }: { projectId: string; listId: string }) {
  const nav = useNav();
  const lists = useProjectLists(projectId);
  const items = useListItems(listId);
  const tasksStore = useTasks();
  const { renameList, deleteList } = useLists();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const list = lists.find((l) => l.id === listId);
  if (!list) {
    return (
      <Center>
        <Text tone="tertiary">This list is gone.</Text>
      </Center>
    );
  }
  const taskItems = items.filter((i) => i.kind === "task" && i.taskId);
  const done = taskItems.filter((i) => tasksStore.byId(i.taskId as string)?.status === "done").length;
  const headings = items.filter((i) => i.kind === "heading").length;

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={styles.home}>
        <View style={styles.titleRow}>
          <Icon name="listOrdered" size={icon.lg} color={colors.textQuaternary} />
          <TextField variant="title" value={list.name} placeholder="List name" onChangeText={(t) => t.trim() && void renameList(list.id, t.trim())} />
        </View>
        <Text variant="mono" tone="quaternary">
          {done}/{taskItems.length} done{headings ? ` · ${headings} ${headings === 1 ? "sublist" : "sublists"}` : ""}
        </Text>
        <Text variant="caption" tone="tertiary" style={{ lineHeight: 18 }}>
          {taskItems.length === 0
            ? "No tasks yet. Add tasks in the column on the left, then drag them into priority order."
            : "Select a task on the left to open it."}
        </Text>
        <View style={styles.footer}>
          <Button label="Delete list" variant="danger" size="sm" onPress={() => setConfirmDelete(true)} />
        </View>
      </ScrollView>
      {confirmDelete ? (
        <ConfirmDialog
          title={`Delete “${list.name}”?`}
          message="The list and its headings are removed. Its tasks stay in the project."
          onConfirm={async () => {
            await deleteList(list.id);
            nav.openProjectSection(projectId, "lists");
          }}
          onClose={() => setConfirmDelete(false)}
        />
      ) : null}
    </View>
  );
}

// The dense browse-list metrics, identical to WorkspaceScreen's. Shared with ProjectView so
// every column under the section chips lines up.
export const listStyles = {
  list: { flex: 1, minHeight: 0, backgroundColor: colors.surfaceCard },
  listHeader: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.sm,
    minHeight: 32,
    paddingLeft: space.sm,
    paddingRight: space.sm,
    paddingTop: space.sm,
    paddingBottom: space.xs,
    // Sit above the search row so the filter dropdown, which overflows the header, paints
    // over the sibling input instead of behind it.
    zIndex: 2,
  },
  search: { paddingHorizontal: space.sm, paddingBottom: space.sm, zIndex: 1 },
  scroll: { padding: space.xs, gap: 1 },
  rows: { gap: 1 },
  empty: { padding: space.xl, textAlign: "center" as const, lineHeight: 18 },
  sectionLabel: { paddingHorizontal: space.sm, paddingTop: space.md, paddingBottom: 3 },
  // A settings-like detail page (project home, list home): prose gutters, 720 max.
  home: { maxWidth: layout.contentMax, width: "100%" as const, marginHorizontal: "auto" as const, paddingHorizontal: space.xxl, paddingVertical: space.xl2, gap: space.md },
  titleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.md },
  footer: { marginTop: space.lg, alignItems: "flex-start" as const },
};

const styles = {
  ...listStyles,
  heading: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.xs, minHeight: 24, paddingLeft: space.sm, paddingRight: space.sm, paddingTop: space.sm, borderRadius: radius.sm },
  rowDragging: { backgroundColor: colors.surfaceActive, borderRadius: radius.sm },
  rowOver: { borderRadius: radius.sm, borderWidth: 1, borderColor: colors.accent, margin: -1 },
};
