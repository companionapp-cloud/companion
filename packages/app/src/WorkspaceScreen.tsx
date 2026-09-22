import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ScrollView, View, type GestureResponderEvent } from "react-native";
import { Center, Icon, IconButton, Input, Kbd, ListRow, Row, SplitView, Spinner, Text, colors, icon, layout, space } from "@companion/design-system";
import { docOfRef, SECTION_OF, useNav, type DocRef } from "./nav-context";
import { useNotes } from "./NotesProvider";
import { useTasks, type TaskFilter } from "./TasksProvider";
import { ScheduledTasks } from "./TaskGroups";
import { newTaskDefaults, scheduleGroups } from "./taskSchedule";
import { NoteEditor } from "./NoteEditor";
import { TaskEditor, TaskRow } from "./TaskEditor";
import { DragHandle } from "./DndContext";
import { repeatSubtitle } from "./repeat";
import { ListFilterMenu } from "./ListFilterMenu";
import { ListSectionFold } from "./ListSectionFold";
import { useMultiSelect, pressMods } from "./MultiSelectProvider";
import { SelectionStack } from "./SelectionStack";
import { MultiSelectBar } from "./MultiSelectBar";
import { CanvasesList } from "./canvas/CanvasesList";
import { CanvasPane } from "./canvas/CanvasPane";
import { useCanvases } from "./canvas/CanvasesProvider";
import { timeAgo } from "./NotificationRow";
import { TourAnchor } from "./onboarding/anchors";

/** One tab's workspace: a split of a browse list (notes, tasks or canvases — whichever
 * section this tab is in) beside the tab's document, or an empty "Nothing selected" state.
 * Each tab renders its own and stays mounted while in the background, so a list's scroll
 * and search and an editor's in-progress state survive a tab switch. */
export function WorkspaceScreen() {
  const nav = useNav();
  const section = nav.current.kind === "tasks" ? "tasks" : nav.current.kind === "canvases" ? "canvases" : "notes";

  return (
    <SplitView
      storageKey={section === "canvases" ? "companion.canvases.listWidth" : "companion.workspace.listWidth"}
      defaultWidth={section === "canvases" ? 220 : layout.listW}
      minWidth={200}
      maxWidth={440}
      aside={section === "tasks" ? <TasksList /> : section === "canvases" ? <CanvasesBrowseList /> : <NotesList />}
    >
      <TabContent />
    </SplitView>
  );
}

/** The detail pane: this tab's document. Nothing is selected on the user's behalf — a tab
 * that is only browsing shows the empty state until something is picked. */
function TabContent() {
  const nav = useNav();
  const ms = useMultiSelect();

  // While ≥2 items are multiselected, the detail pane shows the selection stack (the first
  // selected item on top) instead of the tab's editor.
  if (ms.active && nav.visible) return <SelectionStackBody />;

  const doc = docOfRef(nav.activeTab.ref);
  // Deleting the open document leaves the tab on the list it came from — the notes, tasks
  // or canvases page with nothing selected — the same way the project pane drops back to
  // its section. Closing the tab instead would strand the last tab on the shell's empty
  // state, nowhere near the list the user was working in.
  const backToList = (kind: DocRef["kind"]) => nav.replaceRef({ kind: "browse", section: SECTION_OF[kind] });
  return (
    <View style={styles.detail}>
      {!doc ? (
        <EmptyDetail kind={nav.current.kind === "tasks" ? "task" : nav.current.kind === "canvases" ? "canvas" : "note"} />
      ) : doc.kind === "note" ? (
        <NoteTabBody id={doc.id} onDelete={() => backToList("note")} />
      ) : doc.kind === "task" ? (
        <TaskTabBody id={doc.id} onDelete={() => backToList("task")} />
      ) : (
        <CanvasPane key={doc.id} canvasId={doc.id} onDeleted={() => backToList("canvas")} />
      )}
    </View>
  );
}

const EMPTY_COPY = {
  note: { icon: "file", body: "Pick a note from the list, or start a new one. A blank page is just potential, etc." },
  task: { icon: "tasks", body: "Pick a task from the list, or add one above. Nothing is selected until you say so." },
  canvas: { icon: "canvas", body: "Pick a canvas from the list, or start a new one." },
} as const;

/** The detail pane's empty state. */
export function EmptyDetail({ kind }: { kind: keyof typeof EMPTY_COPY }) {
  const copy = EMPTY_COPY[kind];
  return (
    <Center>
      <Icon name={copy.icon} size={18} color={colors.textQuaternary} />
      <Text variant="title">Nothing selected</Text>
      <Text variant="caption" tone="tertiary" style={styles.emptyBody}>
        {copy.body}
      </Text>
      <Row gap={5} align="center">
        <Kbd>⌘T</Kbd>
        <Text variant="mono" tone="quaternary">
          new tab
        </Text>
      </Row>
    </Center>
  );
}

/** The multiselect preview: the first selected item, rendered on the stack. */
function SelectionStackBody() {
  const ms = useMultiSelect();
  const notes = useNotes();
  const tasks = useTasks();
  const id = ms.primaryId;
  let body: ReactNode = <Center><Text tone="tertiary">Nothing to preview.</Text></Center>;
  if (id && ms.kind === "note") {
    const note = notes.byId(id);
    if (note) body = <NoteEditor key={note.id} note={note} onChange={notes.save} />;
  } else if (id && ms.kind === "task") {
    const task = tasks.byId(id) ?? tasks.seedById(id);
    if (task) body = <TaskEditor key={task.id} task={task} save={tasks.update} />;
  } else if (id && ms.kind === "canvas") {
    body = <CanvasPane key={id} canvasId={id} onDeleted={ms.clear} />;
  }
  return (
    <View style={styles.detail}>
      <MultiSelectBar />
      <SelectionStack count={ms.count}>{body}</SelectionStack>
    </View>
  );
}

function NoteTabBody({ id, onDelete }: { id: string; onDelete: () => void }) {
  const nav = useNav();
  const notes = useNotes();
  const note = notes.byId(id);
  if (!note) {
    return (
      <Center>
        <Text tone="tertiary">This note is gone.</Text>
      </Center>
    );
  }
  return (
    <NoteEditor
      key={note.id}
      note={note}
      onChange={notes.save}
      onDelete={async (nid) => {
        await notes.remove(nid);
        onDelete();
      }}
      onCreatedNote={(nid) => nav.openNote(nid)}
      onOpenRef={(ref) => {
        // Clicking a chip opens its target in a new tab, leaving this note put.
        if (ref.type === "task" || ref.type === "note") nav.openInNewTab({ kind: ref.type, id: ref.id });
        else if (ref.type === "canvas") nav.openCanvas(ref.id);
      }}
    />
  );
}

function TaskTabBody({ id, onDelete }: { id: string; onDelete: () => void }) {
  const tasks = useTasks();
  const nav = useNav();
  // A repeating definition (seed) is not in the actionable list, so fall back to seeds.
  const task = tasks.byId(id) ?? tasks.seedById(id);
  if (!task) {
    return (
      <Center>
        <Text tone="tertiary">This task is gone.</Text>
      </Center>
    );
  }
  return (
    <TaskEditor
      key={task.id}
      task={task}
      save={tasks.update}
      onDelete={async (tid) => {
        await tasks.remove(tid);
        onDelete();
      }}
      onOpenRef={(ref) => {
        // Clicking a chip in the notes opens its target in a new tab, leaving this task put.
        if (ref.type === "task" || ref.type === "note") nav.openInNewTab({ kind: ref.type, id: ref.id });
        else if (ref.type === "canvas") nav.openCanvas(ref.id);
      }}
      onConnectSync={() => nav.openRef({ kind: "view", view: "settings", section: "sync" })}
    />
  );
}

/** The notes browse list (left column). Selecting a note fills the active tab. */
function NotesList() {
  const store = useNotes();
  const nav = useNav();
  const ms = useMultiSelect();
  const [query, setQuery] = useState("");
  const activeDoc = docOfRef(nav.activeTab.ref);
  const activeId = activeDoc?.kind === "note" ? activeDoc.id : null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return store.visible;
    return store.visible.filter((n) => n.title.toLowerCase().includes(q) || n.contentMd.toLowerCase().includes(q));
  }, [store.visible, query]);

  // Announce this list (and its visible order) so multiselect gestures + range work here.
  // Only while this tab is the one on screen — background tabs stay mounted, and
  // registering from there would fight the visible list for the shared scope.
  useEffect(() => {
    if (!nav.visible) return;
    ms.register("notes", "note", filtered.map((n) => n.id));
  }, [ms.register, filtered, nav.visible]);

  if (store.loading) return <Spinner label="Loading your notes…" />;

  return (
    <TourAnchor id="notes.list" style={styles.list}>
      <View style={styles.listHeader}>
        <View style={{ flex: 1 }}>
          <ListFilterMenu
            value={store.filter}
            onChange={store.setFilter}
            options={[
              { value: "unsorted", label: "Unsorted notes" },
              { value: "all", label: "All notes" },
            ]}
          />
        </View>
        <Text variant="mono" tone="quaternary">
          {store.visible.length}
        </Text>
        <IconButton
          label="New note"
          size="sm"
          onPress={() => {
            void store.create().then((n) => nav.openNote(n.id));
          }}
        >
          <Icon name="plus" size={icon.sm} color={colors.textSecondary} />
        </IconButton>
      </View>
      <View style={styles.search}>
        <Input
          size="sm"
          placeholder="Search notes"
          value={query}
          onChangeText={setQuery}
          leadingIcon={<Icon name="search" size={icon.sm} color={colors.textQuaternary} />}
        />
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scroll}>
        {filtered.length ? (
          filtered.map((n) => {
            const selected = ms.active ? ms.isSelected(n.id) : n.id === activeId;
            return (
              <ListRow
                key={n.id}
                accessory={<DragHandle payload={{ kind: "note", id: n.id, label: n.title || "Untitled" }} />}
                icon={<Icon name={n.date ? "today" : "file"} size={icon.sm} color={selected ? colors.textAccent : colors.textQuaternary} />}
                title={n.title || "Untitled"}
                trailing={timeAgo(n.updatedAt)}
                selected={selected}
                onPress={(e) => {
                  if (!ms.press(n.id, pressMods(e))) nav.openNote(n.id);
                }}
              />
            );
          })
        ) : (
          <Text tone="tertiary" variant="caption" style={styles.empty}>
            {query ? "No notes match that." : "Nothing here yet. Tap ＋ to start a note."}
          </Text>
        )}
      </ScrollView>
    </TourAnchor>
  );
}

const EMPTY_TASKS: Record<TaskFilter, string> = {
  unsorted: "Nothing to do. Add a task above.",
  all: "Nothing to do. Add a task above.",
  anytime: "No tasks without a start or a deadline.",
  upcoming: "Nothing coming up.",
  overdue: "Nothing overdue.",
  someday: "Nothing filed under Someday. Set a task’s start to Someday to put it here.",
};

/** The tasks browse list (left column). Selecting a task fills the active tab. */
function TasksList() {
  const store = useTasks();
  const nav = useNav();
  const ms = useMultiSelect();
  const [draft, setDraft] = useState("");
  const activeDoc = docOfRef(nav.activeTab.ref);
  const activeId = activeDoc?.kind === "task" ? activeDoc.id : null;

  const { open, done } = useMemo(() => {
    const openTasks = store.visible.filter((t) => t.status !== "done");
    // In the order shown (grouped views sort by date), so a range-select matches the screen.
    const open = scheduleGroups(openTasks, store.filter)?.flatMap((g) => g.items) ?? openTasks;
    const done = store.visible.filter((t) => t.status === "done");
    return { open, done };
  }, [store.visible, store.filter]);

  // Multiselect covers the actionable tasks (open + done); repeating seeds stay single-select.
  // Gated on visibility (see NotesList) so a background tab doesn't clobber the scope.
  useEffect(() => {
    if (!nav.visible) return;
    ms.register("tasks", "task", [...open, ...done].map((t) => t.id));
  }, [ms.register, open, done, nav.visible]);

  const selectFor = (id: string) => (ms.active ? ms.isSelected(id) : id === activeId);
  const pressTask = (id: string, e: GestureResponderEvent) => {
    if (!ms.press(id, pressMods(e))) nav.openTask(id);
  };

  const add = async () => {
    const title = draft.trim();
    setDraft("");
    // A task typed into a schedule view lands in it: Someday, tomorrow (Upcoming), today (Overdue).
    const t = await store.create({ title: title || "Untitled task", ...newTaskDefaults(store.filter) });
    nav.openTask(t.id);
  };

  if (store.loading) return <Spinner label="Loading your tasks…" />;

  return (
    <View style={styles.list}>
      <View style={styles.listHeader}>
        <TourAnchor id="tasks.filters" style={{ flex: 1 }}>
          <ListFilterMenu
            value={store.filter}
            onChange={store.setFilter}
            options={[
              { value: "unsorted", label: "Unsorted tasks" },
              { value: "all", label: "All tasks" },
              { value: "anytime", label: "Anytime tasks" },
              { value: "upcoming", label: "Upcoming tasks" },
              { value: "overdue", label: "Overdue tasks" },
              { value: "someday", label: "Someday tasks" },
            ]}
          />
        </TourAnchor>
        <Text variant="mono" tone="quaternary">
          {open.length}
        </Text>
      </View>
      <TourAnchor id="tasks.quickAdd" style={styles.search}>
        <Input
          size="sm"
          placeholder="Add a task, press Enter"
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={() => void add()}
          leadingIcon={<Icon name="plus" size={icon.sm} color={colors.textQuaternary} />}
        />
      </TourAnchor>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scroll}>
        {open.length || store.filter === "upcoming" ? (
          <ScheduledTasks
            tasks={open}
            mode={store.filter}
            renderTask={(t) => (
              <TaskRow
                key={t.id}
                task={t}
                selected={selectFor(t.id)}
                onPress={(e) => pressTask(t.id, e)}
                onToggle={() => void store.setStatus(t.id, "done")}
                handle={<DragHandle payload={{ kind: "task", id: t.id, label: t.title || "Untitled task" }} />}
              />
            )}
          />
        ) : (
          <Text tone="tertiary" variant="caption" style={styles.empty}>
            {EMPTY_TASKS[store.filter]}
          </Text>
        )}
        {/* Repeating definitions have no dates of their own, so they sit under the membership scopes only. */}
        {store.seeds.length && (store.filter === "all" || store.filter === "unsorted") ? (
          <ListSectionFold label={`Repeating · ${store.seeds.length}`} storageKey="tasks.repeating" defaultOpen>
            {store.seeds.map((s) => (
              <ListRow
                key={s.id}
                icon={<Icon name="repeat" size={icon.sm} color={s.id === activeId ? colors.textAccent : colors.textQuaternary} />}
                title={s.title || "Untitled task"}
                subtitle={repeatSubtitle(s.repeatRule, s.nextOccurrence)}
                selected={s.id === activeId}
                onPress={() => nav.openTask(s.id)}
              />
            ))}
          </ListSectionFold>
        ) : null}
        {done.length ? (
          <ListSectionFold label={`Completed · ${done.length}`} storageKey="tasks.completed" defaultOpen={false}>
            {done.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                selected={selectFor(t.id)}
                onPress={(e) => pressTask(t.id, e)}
                onToggle={() => void store.setStatus(t.id, "open")}
                handle={<DragHandle payload={{ kind: "task", id: t.id, label: t.title || "Untitled task" }} />}
              />
            ))}
          </ListSectionFold>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = {
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
    // Sit above the search row so the filter dropdown, which overflows the
    // header, paints over the sibling input instead of behind it.
    zIndex: 2,
  },
  search: { paddingHorizontal: space.sm, paddingBottom: space.sm, zIndex: 1 },
  scroll: { padding: space.xs, gap: 1 },
  empty: { padding: space.xl, textAlign: "center" as const, lineHeight: 18 },
  emptyBody: { maxWidth: 300, textAlign: "center" as const, lineHeight: 18 },
  detail: { flex: 1, minWidth: 0, backgroundColor: colors.surfaceCard },
};

/** The canvases browse list (left column): every board, with the All/Unsorted filter.
 *  Selecting one fills the active tab, like a note. */
function CanvasesBrowseList() {
  const nav = useNav();
  const store = useCanvases();
  const activeDoc = docOfRef(nav.activeTab.ref);
  const activeId = activeDoc?.kind === "canvas" ? activeDoc.id : null;
  return (
    <CanvasesList
      selectedId={activeId}
      onSelect={nav.openCanvas}
      onCreate={() => {
        void store.create().then((c) => nav.openCanvas(c.id));
      }}
    />
  );
}
