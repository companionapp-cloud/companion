import { useRef, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useRoute } from "@react-navigation/native";
import { Center, Spinner, Text, colors } from "@companion/design-system";
import { useNav } from "../nav-context";
import { useNotes } from "../NotesProvider";
import { useTasks } from "../TasksProvider";
import { NoteEditor } from "../NoteEditor";
import { NoteGraph } from "../NoteGraph";
import { TaskEditor } from "../TaskEditor";
import { TaskGraph } from "../TaskGraph";
import { MembershipPicker } from "../MembershipPicker";
import { ConfirmDialog } from "../ConfirmDialog";
import { NavAction, NavBar } from "./ui";
import { TourAnchor } from "../onboarding/anchors";

// Full-screen editor routes for the mobile web shell, wrapping the shared editors the
// desktop workspace tabs render (WorkspaceScreen's NoteTabBody/TaskTabBody, minus tabs:
// links push new routes and delete pops back). Only the chrome differs: a nav bar with
// back and the document's actions (projects, graph, delete — hosted here, so both editors
// render headerless); the editors take their 20px body inset from the shell's touch density.

function EditorFrame({ bar, children }: { bar: ReactNode; children: ReactNode }) {
  return (
    <View style={styles.root}>
      {bar}
      <View style={styles.body}>{children}</View>
    </View>
  );
}

export function NoteEditorScreen() {
  const { id } = (useRoute().params ?? {}) as { id?: string };
  const nav = useNav();
  const notes = useNotes();
  const [showProjects, setShowProjects] = useState(false);
  const [showGraph, setShowGraph] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Drawing on the note (PLAN-drawing.md): the pen lives in the nav bar here.
  const [drawing, setDrawing] = useState(false);
  // `notes` gets a new identity on each save; delete reads the freshest store.
  const notesRef = useRef(notes);
  notesRef.current = notes;

  if (notes.loading) {
    return (
      <EditorFrame bar={<NavBar title="Note" />}>
        <Spinner label="Loading your notes…" />
      </EditorFrame>
    );
  }
  const note = id ? notes.byId(id) : null;
  if (!note) {
    return (
      <EditorFrame bar={<NavBar title="Note" />}>
        <Center>
          <Text tone="tertiary">This note is gone.</Text>
        </Center>
      </EditorFrame>
    );
  }
  return (
    // Note-scoped actions live in the nav bar; the shared NoteEditor renders headerless
    // (and so shows its structured props inline once a type is set).
    <EditorFrame
      bar={
        <NavBar
          title={note.title || "Untitled"}
          right={
            <>
              <NavAction icon="folder" label="Move to an area or project" onPress={() => setShowProjects(true)} />
              <TourAnchor id="note.ink">
                <NavAction
                  icon="pen"
                  label={drawing ? "Stop drawing" : "Draw on note"}
                  active={drawing && !showGraph}
                  onPress={() => {
                    setDrawing(!drawing || showGraph);
                    setShowGraph(false);
                  }}
                />
              </TourAnchor>
              <TourAnchor id="note.graph">
                <NavAction icon="graph" label={showGraph ? "Show note" : "Show note graph"} active={showGraph} onPress={() => setShowGraph((v) => !v)} />
              </TourAnchor>
              <NavAction icon="trash" label="Delete note" onPress={() => setConfirmDelete(true)} />
            </>
          }
        />
      }
    >
      {showGraph ? (
        // RNW View is position:relative, giving the absolutely-filled graph canvas a size.
        // Swapping the editor out unmounts it, which flushes its pending edits.
        <View style={styles.graph}>
          <NoteGraph noteId={note.id} />
        </View>
      ) : (
        <NoteEditor
          key={note.id}
          note={note}
          onChange={notes.save}
          showToolbar={false}
          drawing={drawing}
          onDrawingChange={setDrawing}
          onCreatedNote={(nid) => nav.openNote(nid)}
          onOpenRef={(ref) => {
            if (ref.type === "task" || ref.type === "note") nav.openInNewTab({ kind: ref.type, id: ref.id });
            else if (ref.type === "canvas") nav.openCanvas(ref.id);
          }}
        />
      )}
      {showProjects ? <MembershipPicker entityType="note" entityId={note.id} onClose={() => setShowProjects(false)} /> : null}
      {confirmDelete ? (
        <ConfirmDialog
          title="Delete note?"
          message="This note moves to the Trash and is permanently deleted after 30 days. You can restore it from the Trash until then."
          confirmLabel="Delete note"
          onConfirm={async () => {
            await notesRef.current.remove(note.id);
            setConfirmDelete(false);
            nav.back();
          }}
          onClose={() => setConfirmDelete(false)}
        />
      ) : null}
    </EditorFrame>
  );
}

export function TaskEditorScreen() {
  const { id } = (useRoute().params ?? {}) as { id?: string };
  const nav = useNav();
  const tasks = useTasks();
  const [showProjects, setShowProjects] = useState(false);
  const [showGraph, setShowGraph] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // `tasks` gets a new identity on each save; delete reads the freshest store.
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  if (tasks.loading) {
    return (
      <EditorFrame bar={<NavBar title="Task" />}>
        <Spinner label="Loading your tasks…" />
      </EditorFrame>
    );
  }
  // A repeating definition (seed) is not in the actionable list, so fall back to seeds.
  const task = id ? (tasks.byId(id) ?? tasks.seedById(id)) : null;
  if (!task) {
    return (
      <EditorFrame bar={<NavBar title="Task" />}>
        <Center>
          <Text tone="tertiary">This task is gone.</Text>
        </Center>
      </EditorFrame>
    );
  }
  return (
    // Task-scoped actions live in the nav bar; the shared TaskEditor renders headerless
    // (and so shows its structured props inline), as it does in the native app.
    <EditorFrame
      bar={
        <NavBar
          title="Task"
          right={
            <>
              <NavAction icon="folder" label="Move to an area or project" onPress={() => setShowProjects(true)} />
              <NavAction icon="graph" label={showGraph ? "Show task" : "Show task graph"} active={showGraph} onPress={() => setShowGraph((v) => !v)} />
              <NavAction icon="trash" label="Delete task" onPress={() => setConfirmDelete(true)} />
            </>
          }
        />
      }
    >
      {showGraph ? (
        // RNW View is position:relative, giving the absolutely-filled graph canvas a size.
        <View style={styles.graph}>
          <TaskGraph taskId={task.id} />
        </View>
      ) : (
        <TaskEditor
          key={task.id}
          task={task}
          save={tasks.update}
          showToolbar={false}
          onOpenRef={(ref) => {
            if (ref.type === "task" || ref.type === "note") nav.openInNewTab({ kind: ref.type, id: ref.id });
            else if (ref.type === "canvas") nav.openCanvas(ref.id);
          }}
          onConnectSync={() => nav.openRef({ kind: "view", view: "settings", section: "sync" })}
        />
      )}
      {showProjects ? <MembershipPicker entityType="task" entityId={task.id} onClose={() => setShowProjects(false)} /> : null}
      {confirmDelete ? (
        <ConfirmDialog
          title="Delete task?"
          message="This task moves to the Trash and is permanently deleted after 30 days. You can restore it from the Trash until then."
          confirmLabel="Delete task"
          onConfirm={async () => {
            await tasksRef.current.remove(task.id);
            setConfirmDelete(false);
            nav.back();
          }}
          onClose={() => setConfirmDelete(false)}
        />
      ) : null}
    </EditorFrame>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceApp },
  body: { flex: 1, minHeight: 0, backgroundColor: colors.surfaceCard },
  graph: { flex: 1 },
});
