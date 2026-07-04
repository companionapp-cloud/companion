import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { View } from "react-native";
import type { Note } from "@companion/core-bridge";
import { Center, Spinner, Text, colors, dragRegion, radius, shadow, space } from "@companion/design-system";
import { useCore } from "./CoreContext";
import { NoteEditor } from "./NoteEditor";
import { useSync } from "./SyncProvider";

export interface FocusViewProps {
  id: string;
  /** Space reserved at the top for desktop window controls (see App/AppShell). */
  topInset?: number;
}

/** Focus mode: a single note in just the card wrapper — no rail, no app toolbar.
 * Rendered when the URL requests ?note=<id> (its own tab/window). */
export function FocusView({ id, topInset = 0 }: FocusViewProps) {
  const { core, notes } = useCore();
  const { trigger: syncTrigger } = useSync();
  const [note, setNote] = useState<Note | null | undefined>(undefined); // undefined = loading
  const saving = useRef(false);

  const load = useCallback(async () => {
    try {
      setNote(await notes.get(id));
    } catch {
      setNote(null);
    }
  }, [notes, id]);

  useEffect(() => {
    void load();
    return core.on("notes.changed", () => {
      if (!saving.current) void load();
    });
  }, [core, load]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ title?: string; contentMd?: string }>({});
  const scheduleSave = useCallback(
    (noteId: string, fields: { title?: string; contentMd?: string }) => {
      setNote((prev) => (prev ? { ...prev, ...fields } : prev));
      saving.current = true;
      pending.current = { ...pending.current, ...fields };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        const toSave = pending.current;
        pending.current = {};
        const updated = await notes.update(noteId, toSave);
        setNote(updated);
        saving.current = false;
        syncTrigger();
      }, 400);
    },
    [notes, syncTrigger],
  );

  const onDelete = useCallback(
    async (id: string) => {
      await notes.remove(id);
      setNote(null);
      syncTrigger();
      if (typeof window !== "undefined") window.close();
    },
    [notes, syncTrigger],
  );

  let body: ReactNode;
  if (note === undefined) {
    body = <Spinner label="Opening…" />;
  } else if (note === null) {
    body = (
      <Center>
        <Text tone="tertiary">This note isn&apos;t here anymore.</Text>
      </Center>
    );
  } else {
    body = <NoteEditor note={note} onChange={scheduleSave} onDelete={onDelete} />;
  }

  return (
    <View style={styles.root}>
      {topInset > 0 ? <View style={[dragRegion, { height: topInset }]} /> : null}
      <View style={styles.card}>{body}</View>
    </View>
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
