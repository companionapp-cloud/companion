import { useState } from "react";
import { View } from "react-native";
import { Button, Text, colors, radius, shadow, space } from "@companion/design-system";
import type { NoteConflictKind } from "./useNoteSyncGuard";

export interface NoteConflictDialogProps {
  kind: NoteConflictKind;
  /** Discard my changes and take the server version (or accept the delete). */
  onDiscard: () => void | Promise<void>;
  /** Keep my changes as a new note. */
  onSaveAsNew: () => void | Promise<void>;
  /** Deleted case only: bring the note back to life. */
  onRestore: () => void | Promise<void>;
}

/** Shown when a note open in the editor gains a conflicting server version while it has
 *  unsaved local edits (PLAN §7.3 editor UX). The clean cases are handled silently by the
 *  sync guard; this dialog only appears for a dirty editor. It can't be dismissed without a
 *  choice — every option is non-destructive except the explicit "Discard". */
export function NoteConflictDialog({ kind, onDiscard, onSaveAsNew, onRestore }: NoteConflictDialogProps) {
  const [busy, setBusy] = useState(false);
  const run = (fn: () => void | Promise<void>) => async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch {
      setBusy(false); // on success the editor reseeds/unmounts; only reset on failure
    }
  };

  const deleted = kind === "deleted";
  return (
    <View style={styles.scrim}>
      <View style={styles.card}>
        <Text variant="title">{deleted ? "Note deleted elsewhere" : "Note changed elsewhere"}</Text>
        <Text tone="secondary" style={styles.message}>
          {deleted
            ? "This note was deleted on another device while you had unsaved changes. What would you like to do with your changes?"
            : "This note was edited on another device while you had unsaved changes. Keeping both, your changes can become a separate note."}
        </Text>
        <View style={styles.actions}>
          {deleted ? (
            <Button label="Restore note" variant="primary" disabled={busy} onPress={run(onRestore)} />
          ) : null}
          <Button label="Save my changes as a new note" variant={deleted ? "secondary" : "primary"} disabled={busy} onPress={run(onSaveAsNew)} />
          <Button label="Discard my changes" variant="danger" disabled={busy} onPress={run(onDiscard)} />
        </View>
      </View>
    </View>
  );
}

const styles = {
  scrim: {
    position: "absolute" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    backgroundColor: "rgba(17,17,16,0.28)",
    padding: space.xl,
    zIndex: 100,
  },
  card: {
    width: 420,
    maxWidth: "100%" as const,
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    ...shadow.lg,
    padding: space.xl,
    gap: space.md,
  },
  message: { lineHeight: 20 },
  actions: { gap: space.sm, marginTop: space.sm, alignItems: "stretch" as const },
};
