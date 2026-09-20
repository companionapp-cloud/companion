import { useState } from "react";
import { View } from "react-native";
import { Button, Icon, IconButton, Text, colors, layout, row, space, useDensity } from "@companion/design-system";
import { useMultiSelect } from "./MultiSelectProvider";
import { useNotes } from "./NotesProvider";
import { useTasks } from "./TasksProvider";
import { useCanvases } from "./canvas/CanvasesProvider";
import { BulkAssignPicker } from "./BulkAssignPicker";
import { ConfirmDialog } from "./ConfirmDialog";

/** The detail-pane sub-toolbar shown while a multiselection is active (PLAN §4): a count,
 *  bulk "Move to…" (an area or a project) and "Delete" (type-to-confirm), and a cancel that clears the
 *  selection. Rendered above the selection stack in the workspace and project detail panes,
 *  replacing the single-item editor's own sub-toolbar. */
export function MultiSelectBar() {
  const ms = useMultiSelect();
  const notes = useNotes();
  const tasks = useTasks();
  const canvases = useCanvases();
  const [showAssign, setShowAssign] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const touch = useDensity() === "touch";
  const size = touch ? "lg" : "sm";

  const noun = ms.kind === "canvas" ? "canvas" : ms.kind;
  const nounPlural = ms.kind === "canvas" ? "canvases" : `${noun}s`;
  const many = ms.count !== 1;

  const doDelete = async () => {
    if (ms.kind === "task") await tasks.removeMany(ms.selectedIds);
    else if (ms.kind === "canvas") await canvases.removeMany(ms.selectedIds);
    else await notes.removeMany(ms.selectedIds);
    setConfirmDelete(false);
    ms.clear();
  };

  return (
    <>
      <View style={[styles.bar, touch ? styles.barTouch : null]}>
        <IconButton label="Cancel selection" size={size} onPress={ms.clear}>
          <Icon name="close" size={13} color={colors.textSecondary} />
        </IconButton>
        <Text variant="mono" tone="tertiary">
          {ms.count} selected
        </Text>
        <View style={{ flex: 1 }} />
        <Button label="Move to…" variant="ghost" size={size} onPress={() => setShowAssign(true)} />
        <Button label="Delete" variant="danger" size={size} onPress={() => setConfirmDelete(true)} />
      </View>

      {showAssign ? (
        <BulkAssignPicker
          entityType={ms.kind}
          entityIds={ms.selectedIds}
          onDone={() => {
            setShowAssign(false);
            ms.clear();
          }}
          onClose={() => setShowAssign(false)}
        />
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          title={`Delete ${ms.count} ${many ? nounPlural : noun}?`}
          message={`${many ? "These items move" : "This item moves"} to the Trash and ${many ? "are" : "is"} permanently deleted after 30 days. You can restore ${many ? "them" : "it"} from the Trash until then.`}
          confirmLabel={`Delete ${nounPlural}`}
          confirmText="delete"
          confirmTextPrompt={'Type "delete" to confirm:'}
          onConfirm={doDelete}
          onClose={() => setConfirmDelete(false)}
        />
      ) : null}
    </>
  );
}

const styles = {
  bar: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.sm,
    height: layout.subToolbarH,
    paddingHorizontal: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    flexShrink: 0,
  },
  barTouch: { height: row.touch, paddingHorizontal: space.md },
};
