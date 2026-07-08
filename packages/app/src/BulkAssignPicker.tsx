import { useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { MemberEntityType } from "@companion/core-bridge";
import { Icon, IconButton, Spinner, Text, colors, radius, shadow, space, type PressState } from "@companion/design-system";
import { useProjects } from "./ProjectsProvider";

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

  const label = entityType === "task" ? "tasks" : "notes";

  return (
    <View style={styles.scrim}>
      <Pressable style={styles.scrimFill} onPress={onClose} aria-label="Close" />
      <View style={styles.card}>
        <View style={styles.header}>
          <Text variant="title">Assign to project</Text>
          <View style={{ flex: 1 }} />
          <IconButton label="Close" size="sm" onPress={onClose}>
            <Icon name="close" size={16} color={colors.textSecondary} />
          </IconButton>
        </View>
        <Text tone="tertiary" variant="caption" style={styles.subtitle}>
          Add {entityIds.length} {label} to a project.
        </Text>
        <ScrollView contentContainerStyle={styles.body}>
          {projects.length === 0 ? (
            <Text tone="tertiary" variant="caption">
              No projects yet. Create one from the sidebar.
            </Text>
          ) : (
            projects.map((p) => (
              <Pressable
                key={p.id}
                onPress={() => void assign(p.id)}
                disabled={busy}
                style={({ hovered }: PressState) => [styles.row, hovered ? { backgroundColor: colors.surfaceHover } : null]}
              >
                <View style={[styles.dot, { backgroundColor: p.color ?? colors.borderStrong }]} />
                <Text style={{ flex: 1 }} numberOfLines={1}>
                  {p.name}
                </Text>
                <Text variant="caption" tone="tertiary" numberOfLines={1}>
                  {areaName(p.areaId)}
                </Text>
              </Pressable>
            ))
          )}
        </ScrollView>
        {busy ? (
          <View style={styles.busy}>
            <Spinner label="Assigning…" />
          </View>
        ) : null}
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
    zIndex: 100,
  },
  scrimFill: { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0 },
  card: {
    width: 380,
    maxWidth: "92%" as const,
    maxHeight: "80%" as const,
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    ...shadow.lg,
    overflow: "hidden" as const,
  },
  header: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    paddingHorizontal: space.xl,
    paddingTop: space.lg,
    paddingBottom: space.sm,
  },
  subtitle: { paddingHorizontal: space.xl, paddingBottom: space.md },
  body: { padding: space.md, gap: 2 },
  row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderRadius: radius.md,
  },
  dot: { width: 8, height: 8, borderRadius: radius.full },
  busy: { padding: space.md, borderTopWidth: 1, borderTopColor: colors.borderSubtle },
};
