import { useState } from "react";
import { Pressable, View } from "react-native";
import { Button, Input, Text, colors, radius, shadow, space } from "@companion/design-system";

export interface QuickCreateLinkDialogProps {
  /** The unresolved link's text, prefilled as the new entity's title. */
  label: string;
  /** Create the chosen entity titled `title`; the host then swaps the empty link for a chip.
   *  Rejecting leaves the dialog open (the buttons re-enable). */
  onCreate: (kind: "note" | "task", title: string) => void | Promise<void>;
  onCancel: () => void;
}

/** Modal shown when the reader double-clicks an unresolved `[[label]]` link: name the target
 *  and turn it into a real note or task. Built from RN primitives (cross-platform via
 *  react-native-web), mirroring {@link ConfirmDialog}'s scrim/card. The host unmounts this
 *  once a create succeeds (via resolveQuickCreate + clearing its state). */
export function QuickCreateLinkDialog({ label, onCreate, onCancel }: QuickCreateLinkDialogProps) {
  const [title, setTitle] = useState(label);
  const [busy, setBusy] = useState(false);
  const canCreate = !busy && title.trim().length > 0;

  const create = async (kind: "note" | "task") => {
    if (!canCreate) return;
    setBusy(true);
    try {
      await onCreate(kind, title.trim());
      // On success the host unmounts us; only re-enable on failure.
    } catch {
      setBusy(false);
    }
  };

  return (
    <View style={styles.scrim}>
      <Pressable style={styles.scrimFill} onPress={onCancel} aria-label="Cancel" />
      <View style={styles.card}>
        <Text variant="title">Create a linked item</Text>
        <Text tone="secondary" style={styles.message}>
          This link doesn’t point anywhere yet. Create a note or task for it.
        </Text>
        <Input autoFocus value={title} onChangeText={setTitle} placeholder="Title" />
        <View style={styles.actions}>
          <Button label="Cancel" variant="ghost" onPress={onCancel} />
          <View style={{ flex: 1 }} />
          <Button label="Create task" variant="secondary" disabled={!canCreate} onPress={() => void create("task")} />
          <Button label="Create note" variant="primary" disabled={!canCreate} onPress={() => void create("note")} />
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
  scrimFill: { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0 },
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
  actions: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    marginTop: space.sm,
  },
};
