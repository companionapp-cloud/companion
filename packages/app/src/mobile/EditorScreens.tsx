import { useRoute } from "@react-navigation/native";
import { Center, Spinner, Text } from "@companion/design-system";
import { useNav } from "../nav-context";
import { useNotes } from "../NotesProvider";
import { useTasks } from "../TasksProvider";
import { NoteEditor } from "../NoteEditor";
import { TaskEditor } from "../TaskEditor";

// Full-screen editor routes for the mobile web shell, wrapping the shared editors the
// desktop workspace tabs render (WorkspaceScreen's NoteTabBody/TaskTabBody, minus tabs:
// links push new routes and delete pops back).

export function NoteEditorScreen() {
  const { id } = (useRoute().params ?? {}) as { id?: string };
  const nav = useNav();
  const notes = useNotes();
  if (notes.loading) return <Spinner label="Loading your notes…" />;
  const note = id ? notes.byId(id) : null;
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
        nav.back();
      }}
      onCreatedNote={(nid) => nav.openNote(nid)}
      onOpenRef={(ref) => {
        if (ref.type === "task" || ref.type === "note") nav.openInNewTab({ kind: ref.type, id: ref.id });
      }}
    />
  );
}

export function TaskEditorScreen() {
  const { id } = (useRoute().params ?? {}) as { id?: string };
  const nav = useNav();
  const tasks = useTasks();
  if (tasks.loading) return <Spinner label="Loading your tasks…" />;
  // A repeating definition (seed) is not in the actionable list, so fall back to seeds.
  const task = id ? (tasks.byId(id) ?? tasks.seedById(id)) : null;
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
        nav.back();
      }}
      onOpenRef={(ref) => {
        if (ref.type === "task" || ref.type === "note") nav.openInNewTab({ kind: ref.type, id: ref.id });
      }}
      onConnectSync={() => nav.goView("settings")}
    />
  );
}
