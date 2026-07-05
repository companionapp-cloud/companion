import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { MemberEntityType } from "@companion/core-bridge";
import { Icon, IconButton, Text, colors, radius, shadow, space, type PressState } from "@companion/design-system";
import { useProjects } from "./ProjectsProvider";

/** A popover to add/remove an entity (a note today; tasks/habits later) to/from
 * projects — the "membership edited from either end" picker (PLAN §6.6). Reflects the
 * entity's current memberships as toggles over every project, grouped by area. */
export function MembershipPicker({
  entityType,
  entityId,
  onClose,
}: {
  entityType: MemberEntityType;
  entityId: string;
  onClose: () => void;
}) {
  const { projects, areas, addMember, removeMember, membershipsFor } = useProjects();
  const [memberOf, setMemberOf] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void membershipsFor(entityType, entityId).then((rows) => {
      if (cancelled) return;
      setMemberOf(new Set(rows.map((m) => m.projectId)));
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [membershipsFor, entityType, entityId]);

  // Area label per project (for a bit of context), with "Unsorted" for dangling areas.
  const areaName = useMemo(() => {
    const m = new Map(areas.map((a) => [a.id, a.name]));
    return (areaId: string) => m.get(areaId) ?? "Unsorted";
  }, [areas]);

  const toggle = async (projectId: string) => {
    const isMember = memberOf.has(projectId);
    // Optimistic: flip immediately, reconcile on failure.
    setMemberOf((prev) => {
      const next = new Set(prev);
      if (isMember) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
    try {
      if (isMember) await removeMember(projectId, entityType, entityId);
      else await addMember(projectId, entityType, entityId);
    } catch {
      setMemberOf((prev) => {
        const next = new Set(prev);
        if (isMember) next.add(projectId);
        else next.delete(projectId);
        return next;
      });
    }
  };

  return (
    <View style={styles.scrim}>
      <Pressable style={styles.scrimFill} onPress={onClose} aria-label="Close" />
      <View style={styles.card}>
        <View style={styles.header}>
          <Text variant="title">Add to projects</Text>
          <View style={{ flex: 1 }} />
          <IconButton label="Close" size="sm" onPress={onClose}>
            <Icon name="close" size={16} color={colors.textSecondary} />
          </IconButton>
        </View>
        <ScrollView contentContainerStyle={styles.body}>
          {projects.length === 0 ? (
            <Text tone="tertiary" variant="caption">
              No projects yet. Create one from the sidebar.
            </Text>
          ) : (
            projects.map((p) => {
              const on = memberOf.has(p.id);
              return (
                <Pressable
                  key={p.id}
                  onPress={() => void toggle(p.id)}
                  disabled={!loaded}
                  style={({ hovered }: PressState) => [styles.row, hovered ? { backgroundColor: colors.surfaceHover } : null]}
                >
                  <View style={[styles.check, on ? styles.checkOn : null]}>
                    {on ? <Icon name="check" size={13} color={colors.gray0} /> : null}
                  </View>
                  <View style={[styles.dot, { backgroundColor: p.color ?? colors.borderStrong }]} />
                  <Text style={{ flex: 1 }} numberOfLines={1}>
                    {p.name}
                  </Text>
                  <Text variant="caption" tone="tertiary" numberOfLines={1}>
                    {areaName(p.areaId)}
                  </Text>
                </Pressable>
              );
            })
          )}
        </ScrollView>
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
    paddingVertical: space.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  body: { padding: space.md, gap: 2 },
  row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderRadius: radius.md,
  },
  check: {
    width: 18,
    height: 18,
    borderRadius: radius.xs,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  checkOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  dot: { width: 8, height: 8, borderRadius: radius.full },
};
