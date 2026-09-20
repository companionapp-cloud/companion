import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import type { MemberEntityType } from "@companion/core-bridge";
import { Spinner, Text, colors, space } from "@companion/design-system";
import { useProjects } from "./ProjectsProvider";
import { PickerRow, PickerSearch, PickerShell, SEARCH_THRESHOLD, filterProjects, pickerStyles } from "./MembershipPicker";

/** Bulk "Move to" for a multiselection (PLAN §4). Unlike the single-entity MembershipPicker,
 *  this is move-only — picking an area or a project files every selected entity there, taking
 *  each out of wherever it was (content lives in one place — PLAN-areas.md §2.1). Selected
 *  items may be filed differently, so there's no meaningful toggle state. Closes and clears
 *  the selection via `onDone` when finished. */
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
  const { projects, areas, addMembers, addAreaMembers } = useProjects();
  const areaType = entityType === "note" || entityType === "task" || entityType === "canvas" ? entityType : null;
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");

  const areaName = useMemo(() => {
    const m = new Map(areas.map((a) => [a.id, a.name]));
    return (areaId: string) => m.get(areaId) ?? "Unsorted";
  }, [areas]);

  const assign = async (containerId: string, inArea = false) => {
    if (busy) return;
    setBusy(true);
    try {
      if (inArea && areaType) await addAreaMembers(containerId, areaType, entityIds);
      else await addMembers(containerId, entityType, entityIds);
      onDone();
    } catch {
      setBusy(false);
    }
  };

  const noun = entityType === "task" ? "task" : entityType === "canvas" ? "canvas" : "note";
  const label = entityIds.length === 1 ? noun : noun === "canvas" ? "canvases" : `${noun}s`;
  const shown = filterProjects(projects, query);
  const q = query.trim().toLowerCase();
  const shownAreas = areaType ? areas.filter((a) => !q || a.name.toLowerCase().includes(q)) : [];
  const rowCount = projects.length + (areaType ? areas.length : 0);

  return (
    <PickerShell title="Move to" subtitle={`Move ${entityIds.length} ${label} to an area or a project.`} onClose={onClose}>
      {rowCount > SEARCH_THRESHOLD ? <PickerSearch placeholder="Search areas and projects" value={query} onChangeText={setQuery} /> : null}
      <ScrollView contentContainerStyle={pickerStyles.body}>
        {rowCount === 0 ? (
          <Text tone="tertiary" variant="caption" style={pickerStyles.empty}>
            No areas or projects yet. Create one from the sidebar.
          </Text>
        ) : shown.length === 0 && shownAreas.length === 0 ? (
          <Text tone="tertiary" variant="caption" style={pickerStyles.empty}>
            Nothing matches that.
          </Text>
        ) : (
          <>
            {shownAreas.map((a) => (
              <PickerRow key={a.id} onPress={() => void assign(a.id, true)} disabled={busy} label={a.icon ? `${a.icon} ${a.name}` : a.name} meta="area" />
            ))}
            {shown.map((p) => (
              <PickerRow key={p.id} onPress={() => void assign(p.id)} disabled={busy} label={p.icon ? `${p.icon} ${p.name}` : p.name} meta={areaName(p.areaId)} color={p.color ?? null} />
            ))}
          </>
        )}
      </ScrollView>
      {busy ? (
        <View style={styles.busy}>
          <Spinner inline label="Moving…" />
        </View>
      ) : null}
    </PickerShell>
  );
}

const styles = {
  busy: { paddingHorizontal: space.lg, paddingVertical: space.md, borderTopWidth: 1, borderTopColor: colors.borderSubtle },
};
