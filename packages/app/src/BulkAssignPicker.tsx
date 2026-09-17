import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import type { MemberEntityType } from "@companion/core-bridge";
import { Spinner, Text, colors, space } from "@companion/design-system";
import { useProjects } from "./ProjectsProvider";
import { PickerRow, PickerSearch, PickerShell, SEARCH_THRESHOLD, filterProjects, pickerStyles } from "./MembershipPicker";

/** Bulk "Assign to project" for a multiselection (PLAN §4). Unlike the single-entity
 *  MembershipPicker, this is assign-only — picking a project adds every selected entity to
 *  it (selected items may have differing memberships, so there's no meaningful toggle
 *  state). Closes and clears the selection via `onDone` when finished. */
export function BulkAssignPicker({
  entityType,
  entityIds,
  onDone,
  onClose,
}: {
  entityType: MemberEntityType;
  entityIds: string[];
  /** Called after a successful assign — the host closes the picker and clears selection. */
  onDone: () => void;
  onClose: () => void;
}) {
  const { projects, areas, addMembers } = useProjects();
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");

  const areaName = useMemo(() => {
    const m = new Map(areas.map((a) => [a.id, a.name]));
    return (areaId: string) => m.get(areaId) ?? "Unsorted";
  }, [areas]);

  const assign = async (projectId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await addMembers(projectId, entityType, entityIds);
      onDone();
    } catch {
      setBusy(false);
    }
  };

  const noun = entityType === "task" ? "task" : "note";
  const label = entityIds.length === 1 ? noun : `${noun}s`;
  const shown = filterProjects(projects, query);

  return (
    <PickerShell title="Assign to project" subtitle={`Add ${entityIds.length} ${label} to a project.`} onClose={onClose}>
      {projects.length > SEARCH_THRESHOLD ? <PickerSearch placeholder="Search projects" value={query} onChangeText={setQuery} /> : null}
      <ScrollView contentContainerStyle={pickerStyles.body}>
        {projects.length === 0 ? (
          <Text tone="tertiary" variant="caption" style={pickerStyles.empty}>
            No projects yet. Create one from the sidebar.
          </Text>
        ) : shown.length === 0 ? (
          <Text tone="tertiary" variant="caption" style={pickerStyles.empty}>
            No projects match that.
          </Text>
        ) : (
          shown.map((p) => <PickerRow key={p.id} onPress={() => void assign(p.id)} disabled={busy} label={p.name} meta={areaName(p.areaId)} color={p.color ?? null} />)
        )}
      </ScrollView>
      {busy ? (
        <View style={styles.busy}>
          <Spinner inline label="Assigning…" />
        </View>
      ) : null}
    </PickerShell>
  );
}

const styles = {
  busy: { paddingHorizontal: space.lg, paddingVertical: space.md, borderTopWidth: 1, borderTopColor: colors.borderSubtle },
};
