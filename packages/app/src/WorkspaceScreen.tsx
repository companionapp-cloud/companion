import { useMemo, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import type { Note } from "@companion/core-bridge";
import { Center, Icon, Input, ListRow, SplitView, Spinner, Text, colors, layout, space } from "@companion/design-system";
import { useNav } from "./nav-context";
import { useNotes } from "./NotesProvider";
import { useTasks } from "./TasksProvider";
import { NoteEditor } from "./NoteEditor";
import { TaskEditor, TaskRow } from "./TaskEditor";

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
    />
  );
}

function TaskTabBody({ id, onDelete }: { id: string; onDelete: () => void }) {
  const tasks = useTasks();
  const task = tasks.byId(id);
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
    if (!q) return store.notes;
    return store.notes.filter((n) => n.title.toLowerCase().includes(q) || n.contentMd.toLowerCase().includes(q));
  }, [store.notes, query]);

  if (store.loading) return <Spinner label="Loading your notes…" />;

  return (
    <View style={styles.list}>
      <View style={styles.listHeader}>
        <Text variant="caption" tone="secondary" style={{ flex: 1, fontWeight: "600" }}>
          All notes
        </Text>
        <Text variant="mono" tone="tertiary">
          {store.notes.length}
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
            <ListRow
              key={n.id}
              icon={<Icon name="file" size={17} color={n.id === activeId ? colors.accentHover : colors.textTertiary} />}
              title={n.title || "Untitled"}
              subtitle={notePreview(n)}
              selected={n.id === activeId}
              onPress={() => nav.openNote(n.id)}
            />
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
    const open = store.tasks.filter((t) => t.status !== "done");
    const done = store.tasks.filter((t) => t.status === "done");
    return { open, done };
  }, [store.tasks]);

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
        <Text variant="caption" tone="secondary" style={{ flex: 1, fontWeight: "600" }}>
          Tasks
        </Text>
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
            <TaskRow key={t.id} task={t} selected={t.id === activeId} onPress={() => nav.openTask(t.id)} onToggle={() => void store.setStatus(t.id, "done")} />
          ))
        ) : (
          <Text tone="tertiary" variant="caption" style={styles.empty}>
            Nothing to do. Add a task above.
          </Text>
        )}
        {done.length ? (
          <>
            <Text variant="caption" tone="tertiary" style={styles.doneLabel}>
              COMPLETED · {done.length}
            </Text>
            {done.map((t) => (
              <TaskRow key={t.id} task={t} selected={t.id === activeId} onPress={() => nav.openTask(t.id)} onToggle={() => void store.setStatus(t.id, "open")} />
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

const styles = {
  list: { flex: 1, minHeight: 0, backgroundColor: colors.surfaceCard },
  listHeader: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.md,
  },
  search: { paddingHorizontal: space.md, paddingBottom: space.md },
  empty: { padding: space.xxl, textAlign: "center" as const, lineHeight: 20 },
  doneLabel: { fontWeight: "600" as const, letterSpacing: 0.5, paddingHorizontal: space.md, paddingTop: space.lg, paddingBottom: space.xs },
  detail: { flex: 1, minWidth: 0, backgroundColor: colors.surfaceCard },
  fill: { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0 },
  hidden: { display: "none" as const },
};
