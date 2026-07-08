import { useState } from "react";
import { View } from "react-native";
import { Button, Icon, IconButton, Text, colors, space } from "@companion/design-system";
import { useMultiSelect } from "./MultiSelectProvider";
import { useNotes } from "./NotesProvider";
import { useTasks } from "./TasksProvider";
import { BulkAssignPicker } from "./BulkAssignPicker";
import { ConfirmDialog } from "./ConfirmDialog";

/** The detail-pane sub-toolbar shown while a multiselection is active (PLAN §4): a count,
 *  bulk "Assign to project" and "Delete" (type-to-confirm), and a cancel that clears the
 *  selection. Rendered above the selection stack in the workspace and project detail panes,
 *  replacing the single-item editor's own sub-toolbar. */
export function MultiSelectBar() {
  const ms = useMultiSelect();
  const notes = useNotes();
  const tasks = useTasks();
  const [showAssign, setShowAssign] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const noun = ms.kind === "task" ? "task" : "note";
  const nounPlural = `${noun}s`;
  const many = ms.count !== 1;

  const doDelete = async () => {
    if (ms.kind === "task") await tasks.removeMany(ms.selectedIds);
    else await notes.removeMany(ms.selectedIds);
    setConfirmDelete(false);
    ms.clear();
  };

  return (
    <>
      <View style={styles.bar}>
        <IconButton label="Cancel selection" size="sm" onPress={ms.clear}>
          <Icon name="close" size={16} color={colors.textSecondary} />
        </IconButton>
        <Text variant="label" tone="secondary">
          {ms.count} {many ? nounPlural : noun} selected
        </Text>
        <View style={{ flex: 1 }} />
        <Button label="Assign to project" variant="secondary" size="sm" onPress={() => setShowAssign(true)} />
        <Button label="Delete" variant="danger" size="sm" onPress={() => setConfirmDelete(true)} />
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
    gap: space.md,
    height: 44,
    paddingHorizontal: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    flexShrink: 0,
  },
};
