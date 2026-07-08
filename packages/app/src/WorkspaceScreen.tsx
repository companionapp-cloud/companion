import { useMemo, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import type { Note } from "@companion/core-bridge";
import { Center, Icon, Input, ListRow, SplitView, Spinner, Text, colors, layout, space } from "@companion/design-system";
import { useNav } from "./nav-context";
import { useNotes } from "./NotesProvider";
import { useTasks } from "./TasksProvider";
import { NoteEditor } from "./NoteEditor";
import { TaskEditor, TaskRow } from "./TaskEditor";
import { Draggable } from "./DndContext";
import { repeatLabel } from "./repeat";
import { ListFilterMenu } from "./ListFilterMenu";

/** The web/desktop workspace: a persistent split of a browse list (notes or tasks, chosen
 * by the rail) and a shared tab strip. Notes and tasks share one set of tabs (in the
 * toolbar); this renders the active tab's document — or an empty "Nothing selected" state.
 * Mounted once by the shell and shown/hidden, so every open tab's editor stays alive. */
export function WorkspaceScreen() {
  const nav = useNav();
  // Keep the last browsed list so the aside doesn't flip while the workspace is hidden
  // (e.g. when the user is on the graph). Only a notes/tasks route changes it.
  const browseRef = useRef<"notes" | "tasks">("notes");
  if (nav.current.kind === "notes") browseRef.current = "notes";
  else if (nav.current.kind === "tasks") browseRef.current = "tasks";

  return (
    <SplitView
      storageKey="companion.workspace.listWidth"
      defaultWidth={layout.listW}
      minWidth={240}
      maxWidth={480}
      aside={browseRef.current === "tasks" ? <TasksList /> : <NotesList />}
    >
      <TabContent />
    </SplitView>
  );
}

/** The content pane: one editor per open tab (all mounted so their in-progress state
 * survives tab switches), only the active one visible; an empty active tab shows the
 * "Nothing selected" placeholder. */
function TabContent() {
  const nav = useNav();

  return (
    <View style={styles.detail}>
      {nav.tabs.map((tab, i) => {
        if (!tab.ref) return null;
        const visible = i === nav.activeIndex;
        const ref = tab.ref;
        return (
          <View key={tab.uid} style={[styles.fill, visible ? null : styles.hidden]}>
            {ref.kind === "note" ? (
              <NoteTabBody id={ref.id} onDelete={() => nav.closeTab(i)} />
            ) : (
              <TaskTabBody id={ref.id} onDelete={() => nav.closeTab(i)} />
            )}
          </View>
        );
      })}
      {!nav.activeTab.ref ? (
        <Center>
          <Text tone="tertiary">Nothing selected. Pick something from the list, or open a new tab.</Text>
        </Center>
      ) : null}
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
      }}
      onConnectSync={() => nav.goView("settings")}
    />
  );
}

/** The notes browse list (left column). Selecting a note fills the active tab. */
function NotesList() {
  const store = useNotes();
  const nav = useNav();
  const [query, setQuery] = useState("");
  const activeRef = nav.activeTab.ref;
  const activeId = activeRef?.kind === "note" ? activeRef.id : null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return store.visible;
    return store.visible.filter((n) => n.title.toLowerCase().includes(q) || n.contentMd.toLowerCase().includes(q));
  }, [store.visible, query]);

  if (store.loading) return <Spinner label="Loading your notes…" />;

  return (
    <View style={styles.list}>
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
        <Text variant="mono" tone="tertiary">
          {store.visible.length}
        </Text>
      </View>
      <View style={styles.search}>
        <Input
          size="sm"
          placeholder="Search notes"
          value={query}
          onChangeText={setQuery}
          leadingIcon={<Icon name="search" size={15} color={colors.textTertiary} />}
        />
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: space.md, gap: 2 }}>
        {filtered.length ? (
          filtered.map((n) => (
            <Draggable key={n.id} payload={{ kind: "note", id: n.id, label: n.title || "Untitled" }}>
              <ListRow
                icon={<Icon name="file" size={17} color={n.id === activeId ? colors.accentHover : colors.textTertiary} />}
                title={n.title || "Untitled"}
                subtitle={notePreview(n)}
                selected={n.id === activeId}
                onPress={() => nav.openNote(n.id)}
              />
            </Draggable>
          ))
        ) : (
          <Text tone="tertiary" variant="caption" style={styles.empty}>
            {query ? "No notes match that." : "Nothing here yet. A blank page is just potential, etc."}
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

/** The tasks browse list (left column). Selecting a task fills the active tab. */
function TasksList() {
  const store = useTasks();
  const nav = useNav();
  const [draft, setDraft] = useState("");
  const activeRef = nav.activeTab.ref;
  const activeId = activeRef?.kind === "task" ? activeRef.id : null;

  const { open, done } = useMemo(() => {
    const open = store.visible.filter((t) => t.status !== "done");
    const done = store.visible.filter((t) => t.status === "done");
    return { open, done };
  }, [store.visible]);

  const add = async () => {
    const title = draft.trim();
    setDraft("");
    const t = await store.create({ title: title || "Untitled task" });
    nav.openTask(t.id);
  };

  if (store.loading) return <Spinner label="Loading your tasks…" />;

  return (
    <View style={styles.list}>
      <View style={styles.listHeader}>
        <View style={{ flex: 1 }}>
          <ListFilterMenu
            value={store.filter}
            onChange={store.setFilter}
            options={[
              { value: "unsorted", label: "Unsorted tasks" },
              { value: "all", label: "All tasks" },
            ]}
          />
        </View>
        <Text variant="mono" tone="tertiary">
          {open.length}
        </Text>
      </View>
      <View style={styles.search}>
        <Input
          size="sm"
          placeholder="Add a task, press Enter"
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={() => void add()}
          leadingIcon={<Icon name="plus" size={15} color={colors.textTertiary} />}
        />
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: space.md, gap: 2 }}>
        {open.length ? (
          open.map((t) => (
            <Draggable key={t.id} payload={{ kind: "task", id: t.id, label: t.title || "Untitled task" }}>
              <TaskRow task={t} selected={t.id === activeId} onPress={() => nav.openTask(t.id)} onToggle={() => void store.setStatus(t.id, "done")} />
            </Draggable>
          ))
        ) : (
          <Text tone="tertiary" variant="caption" style={styles.empty}>
            Nothing to do. Add a task above.
          </Text>
        )}
        {store.seeds.length ? (
          <>
            <Text variant="caption" tone="tertiary" style={styles.doneLabel}>
              REPEATING · {store.seeds.length}
            </Text>
            {store.seeds.map((s) => (
              <ListRow
                key={s.id}
                icon={<Icon name="repeat" size={16} color={s.id === activeId ? colors.accentHover : colors.textTertiary} />}
                title={s.title || "Untitled task"}
                subtitle={repeatSubtitle(s.repeatRule, s.nextOccurrence)}
                selected={s.id === activeId}
                onPress={() => nav.openTask(s.id)}
              />
            ))}
          </>
        ) : null}
        {done.length ? (
          <>
            <Text variant="caption" tone="tertiary" style={styles.doneLabel}>
              COMPLETED · {done.length}
            </Text>
            {done.map((t) => (
              <Draggable key={t.id} payload={{ kind: "task", id: t.id, label: t.title || "Untitled task" }}>
                <TaskRow task={t} selected={t.id === activeId} onPress={() => nav.openTask(t.id)} onToggle={() => void store.setStatus(t.id, "open")} />
              </Draggable>
            ))}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function notePreview(n: Note): string {
  const body = n.contentMd.replace(/\s+/g, " ").trim();
  return body || "No additional text";
}

/** Subtitle for a repeating definition: its cadence plus the next occurrence date. */
function repeatSubtitle(rule?: string | null, next?: string | null): string {
  const cadence = repeatLabel(rule) ?? "Repeats";
  if (!next) return cadence;
  const d = new Date(next);
  if (Number.isNaN(d.getTime())) return cadence;
  return `${cadence} · next ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

const styles = {
  list: { flex: 1, minHeight: 0, backgroundColor: colors.surfaceCard },
  listHeader: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.md,
    // Sit above the search row so the filter dropdown, which overflows the
    // header, paints over the sibling input instead of behind it.
    zIndex: 2,
  },
  search: { paddingHorizontal: space.md, paddingBottom: space.md, zIndex: 1 },
  empty: { padding: space.xxl, textAlign: "center" as const, lineHeight: 20 },
  doneLabel: { fontWeight: "600" as const, letterSpacing: 0.5, paddingHorizontal: space.md, paddingTop: space.lg, paddingBottom: space.xs },
  detail: { flex: 1, minWidth: 0, backgroundColor: colors.surfaceCard },
  fill: { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0 },
  hidden: { display: "none" as const },
};
