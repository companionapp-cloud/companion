import { useEffect, useMemo, useState } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import { useRoute } from "@react-navigation/native";
import type { Canvas } from "@companion/core-bridge";
import { Icon, Spinner, Text, colors, space } from "@companion/design-system";
import { useNav } from "../nav-context";
import { useCore } from "../CoreContext";
import { useProjects } from "../ProjectsProvider";
import { timeAgo } from "../NotificationRow";
import { useCanvases } from "../canvas/CanvasesProvider";
import { CanvasPane } from "../canvas/CanvasPane";
import { CardRow, Fab } from "./ui";

// Canvases for the mobile web shell (PLAN-canvases.md): a full-screen list (globally, or
// scoped to a project's member boards) and the board itself as a pushed route.

/** Tracks a project's member canvas ids, refreshed as memberships change. */
function useMemberCanvasIds(projectId: string | undefined): Set<string> | null {
  const { core } = useCore();
  const { membershipsForProject } = useProjects();
  const [ids, setIds] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!projectId) {
      setIds(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      const rows = await membershipsForProject(projectId);
      if (!cancelled) setIds(new Set(rows.filter((m) => m.entityType === "canvas").map((m) => m.entityId)));
    };
    void load();
    const offNav = core.on("nav.changed", () => void load());
    const offData = core.on("data.changed", () => void load());
    return () => {
      cancelled = true;
      offNav();
      offData();
    };
  }, [projectId, membershipsForProject, core]);
  return ids;
}

export function CanvasesListScreen({ projectId }: { projectId?: string }) {
  const store = useCanvases();
  const nav = useNav();
  const { addMember } = useProjects();
  const memberIds = useMemberCanvasIds(projectId);

  const canvases = useMemo(() => {
    if (!projectId) return store.canvases;
    if (!memberIds) return [];
    return store.canvases.filter((c) => memberIds.has(c.id));
  }, [store.canvases, projectId, memberIds]);

  const create = async () => {
    const c = await store.create();
    if (projectId) await addMember(projectId, "canvas", c.id);
    nav.openCanvas(c.id);
  };

  if (store.loading) return <Spinner label="Loading your canvases…" />;

  return (
    <View style={styles.container}>
      <FlatList
        data={canvases}
        keyExtractor={(c) => c.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text tone="tertiary" style={styles.empty}>
            No canvases yet. Tap + to start a board.
          </Text>
        }
        renderItem={({ item }) => <CanvasCard canvas={item} onPress={() => nav.openCanvas(item.id)} />}
      />
      <Fab label="New canvas" onPress={() => void create()} />
    </View>
  );
}

function CanvasCard({ canvas, onPress }: { canvas: Canvas; onPress: () => void }) {
  return (
    <CardRow
      leading={<Icon name="canvas" size={19} color={colors.textTertiary} />}
      title={canvas.name || "Untitled canvas"}
      subtitle={`Edited ${timeAgo(canvas.updatedAt)}`}
      divided={false}
      onPress={onPress}
    />
  );
}

/** The board route (/canvases/:id): the shared pane (name, projects, delete, editor). */
export function CanvasScreen() {
  const params = (useRoute().params ?? {}) as { id?: string };
  const nav = useNav();
  if (!params.id) return null;
  return (
    <View style={styles.container}>
      <CanvasPane key={params.id} canvasId={params.id} onDeleted={nav.back} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surfaceApp },
  list: { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: 96, gap: space.sm },
  empty: { padding: space.xl, textAlign: "center", lineHeight: 20 },
});
