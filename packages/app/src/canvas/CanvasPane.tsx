import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Center, Icon, IconButton, Text, TextField, colors, space } from "@companion/design-system";
import { ConfirmDialog } from "../ConfirmDialog";
import { MembershipPicker } from "../MembershipPicker";
import { useCanvases } from "./CanvasesProvider";
import { CanvasEditor } from "./CanvasEditor";
import type { CanvasRefKind } from "./host";

/** A board's detail pane: an editable name, the project-membership picker, delete, and the
 *  editor beneath. Shared by the root Canvases view and a project's Canvases section. */
export function CanvasPane({ canvasId, onDeleted, onOpenRef }: { canvasId: string; onDeleted?: () => void; onOpenRef?: (ref: { type: CanvasRefKind; id: string }) => void }) {
  const store = useCanvases();
  const canvas = store.byId(canvasId);
  const [showProjects, setShowProjects] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The title is edited against a local draft and saved on a short debounce. Saving every
  // keystroke re-rendered the controlled field with a stale name mid-flight, which snapped
  // the caret around (it read like the field losing focus). A change that arrives from
  // elsewhere (another device) replaces the draft only when it differs from what we saved.
  const [draft, setDraft] = useState(canvas?.name ?? "");
  const lastSaved = useRef(canvas?.name ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const name = canvas?.name ?? "";
    if (name !== lastSaved.current) {
      lastSaved.current = name;
      setDraft(name);
    }
  }, [canvas?.name]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const onChangeName = (t: string) => {
    setDraft(t);
    lastSaved.current = t;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void store.rename(canvasId, t), 400);
  };

  if (!canvas) {
    return (
      <Center>
        <Text tone="tertiary">{store.loading ? "Loading…" : "This canvas is gone."}</Text>
      </Center>
    );
  }

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={styles.header}>
        <Icon name="canvas" size={18} color={colors.textTertiary} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <TextField variant="title" value={draft} placeholder="Untitled canvas" onChangeText={onChangeName} />
        </View>
        <IconButton label="Projects" size="sm" active={showProjects} onPress={() => setShowProjects((v) => !v)}>
          <Icon name="folder" size={16} color={showProjects ? colors.accentHover : colors.textSecondary} />
        </IconButton>
        <IconButton label="Delete canvas" size="sm" onPress={() => setConfirmDelete(true)}>
          <Icon name="trash" size={16} color={colors.textSecondary} />
        </IconButton>
      </View>
      <View style={{ flex: 1, minHeight: 0 }}>
        <CanvasEditor key={canvas.id} canvasId={canvas.id} onOpenRef={onOpenRef} />
      </View>
      {showProjects ? <MembershipPicker entityType="canvas" entityId={canvas.id} onClose={() => setShowProjects(false)} /> : null}
      {confirmDelete ? (
        <ConfirmDialog
          title="Delete canvas?"
          message="This canvas moves to the Trash and is permanently deleted after 30 days. Its notes and tasks are untouched."
          confirmLabel="Delete canvas"
          onConfirm={async () => {
            await store.remove(canvas.id);
            setConfirmDelete(false);
            onDeleted?.();
          }}
          onClose={() => setConfirmDelete(false)}
        />
      ) : null}
    </View>
  );
}

const styles = {
  header: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.surfaceCard,
  },
};
