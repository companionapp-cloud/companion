import { type ReactNode } from "react";
import { View } from "react-native";
import { Center, Spinner, Text, colors, dragRegion, radius, shadow, space } from "@companion/design-system";
import { useNotes } from "./NotesProvider";
import { useTasks } from "./TasksProvider";
import { NoteEditor } from "./NoteEditor";
import { TaskEditor } from "./TaskEditor";
import type { FocusTarget } from "./focus";

export interface FocusViewProps {
  target: FocusTarget;
  /** Space reserved at the top for desktop window controls (see App/AppShell). */
  topInset?: number;
}

/** Focus mode: a single note or task in just the card wrapper — no rail, no toolbar, no
 * tabs. Rendered when the URL requests ?note=<id> / ?task=<id> (its own tab/window). The
 * expand/pop-out action in the workspace opens this. */
export function FocusView({ target, topInset = 0 }: FocusViewProps) {
  return (
    <View style={styles.root}>
      {topInset > 0 ? <View style={[dragRegion, { height: topInset }]} /> : null}
      <View style={styles.card}>{target.kind === "note" ? <FocusNote id={target.id} /> : <FocusTask id={target.id} />}</View>
    </View>
  );
}

function closeWindow() {
  if (typeof window !== "undefined" && typeof window.close === "function") window.close();
}

function FocusNote({ id }: { id: string }) {
  const notes = useNotes();
  const note = notes.byId(id);
  if (!note) return <Gone loading={notes.loading} label="This note isn’t here anymore." />;
  return (
    <NoteEditor
      note={note}
      onChange={notes.save}
      onDelete={async (nid) => {
        await notes.remove(nid);
        closeWindow();
      }}
    />
  );
}

function FocusTask({ id }: { id: string }) {
  const tasks = useTasks();
  const task = tasks.byId(id);
  if (!task) return <Gone loading={tasks.loading} label="This task isn’t here anymore." />;
  return (
    <TaskEditor
      task={task}
      save={tasks.update}
      onDelete={async (tid) => {
        await tasks.remove(tid);
        closeWindow();
      }}
    />
  );
}

function Gone({ loading, label }: { loading: boolean; label: string }): ReactNode {
  if (loading) return <Spinner label="Opening…" />;
  return (
    <Center>
      <Text tone="tertiary">{label}</Text>
    </Center>
  );
}

const styles = {
  root: { flex: 1, backgroundColor: colors.surfaceApp, padding: space.lg },
  card: {
    flex: 1,
    minHeight: 0,
    backgroundColor: colors.surfaceCard,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.xl,
    overflow: "hidden" as const,
    ...shadow.sm,
  },
};
