import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useRoute } from "@react-navigation/native";
import type { Canvas } from "@companion/core-bridge";
import { Center, Input, Spinner, Text, colors, space } from "@companion/design-system";
import { useNav } from "../nav-context";
import { useProjects } from "../ProjectsProvider";
import { timeAgo } from "../NotificationRow";
import { useCanvases } from "../canvas/CanvasesProvider";
import { CanvasEditor } from "../canvas/CanvasEditor";
import { ConfirmDialog } from "../ConfirmDialog";
import { MembershipPicker } from "../MembershipPicker";
import { useMemberIds } from "./ListScreens";
import { Card, CardRow, EmptyCaption, FAB_CLEARANCE, Fab, NavAction, NavBar, ROW_ICON_INSET, RowIcon } from "./ui";
import { TourAnchor } from "../onboarding/anchors";

// Canvases for the mobile web shell (PLAN-canvases.md): a full-screen list (globally, or
// scoped to a project's member boards) and the board itself as a pushed route. Inside a
// project the project screen owns the nav bar, so the list renders bare.

export function CanvasesListScreen({ projectId, areaId }: { projectId?: string; areaId?: string }) {
  const store = useCanvases();
  const nav = useNav();
  const { addMember, addAreaMember } = useProjects();
  const memberIds = useMemberIds(projectId, "canvas", areaId);
  // Scoped to a project or an area: the host screen owns the nav bar, and new boards are filed there.
  const scoped = !!(projectId || areaId);

  const canvases = useMemo(() => {
    if (!scoped) return store.canvases;
    if (!memberIds) return [];
    return store.canvases.filter((c) => memberIds.has(c.id));
  }, [store.canvases, scoped, memberIds]);

  const create = async () => {
    const c = await store.create();
    if (projectId) await addMember(projectId, "canvas", c.id);
    else if (areaId) await addAreaMember(areaId, "canvas", c.id);
    nav.openCanvas(c.id);
  };

  const bar = scoped ? null : <NavBar title="Canvases" right={<NavAction icon="plus" label="New canvas" onPress={() => void create()} />} />;

  if (store.loading) {
    return (
      <View style={styles.container}>
        {bar}
        <Spinner label="Loading your canvases…" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {bar}
      <TourAnchor id={scoped ? "canvases.scoped" : "canvases.list"} style={styles.body}>
        <ScrollView contentContainerStyle={styles.list}>
          {canvases.length ? (
            <Card>
              {canvases.map((c, i) => (
                <CanvasCard key={c.id} canvas={c} isLast={i === canvases.length - 1} onPress={() => nav.openCanvas(c.id)} />
              ))}
            </Card>
          ) : (
            <EmptyCaption>No canvases yet. Tap + to start a board.</EmptyCaption>
          )}
        </ScrollView>
      </TourAnchor>
      <Fab label="New canvas" onPress={() => void create()} />
    </View>
  );
}

function CanvasCard({ canvas, isLast, onPress }: { canvas: Canvas; isLast: boolean; onPress: () => void }) {
  return (
    <CardRow
      leading={<RowIcon name="canvas" />}
      separatorInset={ROW_ICON_INSET}
      title={canvas.name || "Untitled canvas"}
      subtitle={`Edited ${timeAgo(canvas.updatedAt)}`}
      isLast={isLast}
      onPress={onPress}
    />
  );
}

/** The board route (/canvases/:id). Native chrome: the board's name is the bar's title
 *  (tap to rename) and its document actions — projects, delete — are bar icons, over the
 *  shared editor. The board's tools stay in the editor's own strip: CanvasEditor exposes
 *  no handle for them, so a bottom tool bar has nothing to drive yet. */
export function CanvasScreen() {
  const params = (useRoute().params ?? {}) as { id?: string };
  const nav = useNav();
  const store = useCanvases();
  const canvas = params.id ? store.byId(params.id) : undefined;
  const [showProjects, setShowProjects] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The title reads as a heading; tapping it swaps in a field to rename (commits on blur/Enter).
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const commitName = () => {
    const name = nameDraft?.trim();
    setNameDraft(null);
    if (canvas && name != null && name !== canvas.name) void store.rename(canvas.id, name);
  };

  if (!params.id) return null;
  if (!canvas) {
    return (
      <View style={styles.container}>
        <NavBar title="Canvas" />
        <Center>
          <Text variant="caption" tone="tertiary">
            {store.loading ? "Loading…" : "This canvas is gone."}
          </Text>
        </Center>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <NavBar
        title={canvas.name || "Untitled canvas"}
        titleSlot={
          nameDraft !== null ? (
            <View style={styles.titleSlot}>
              <Input value={nameDraft} placeholder="Untitled canvas" autoFocus onChangeText={setNameDraft} onSubmitEditing={commitName} onBlur={commitName} />
            </View>
          ) : (
            <Pressable style={styles.titleSlot} onPress={() => setNameDraft(canvas.name ?? "")} aria-label="Rename canvas">
              <Text variant="title" tone={canvas.name ? "default" : "tertiary"} numberOfLines={1}>
                {canvas.name || "Untitled canvas"}
              </Text>
            </Pressable>
          )
        }
        right={
          <>
            <TourAnchor id="canvas.file">
              <NavAction icon="folder" label="Move to an area or project" active={showProjects} onPress={() => setShowProjects((v) => !v)} />
            </TourAnchor>
            <NavAction icon="trash" label="Delete canvas" onPress={() => setConfirmDelete(true)} />
          </>
        }
      />
      <TourAnchor id="canvas.board" style={styles.board}>
        <CanvasEditor key={canvas.id} canvasId={canvas.id} />
      </TourAnchor>
      {showProjects ? <MembershipPicker entityType="canvas" entityId={canvas.id} onClose={() => setShowProjects(false)} /> : null}
      {confirmDelete ? (
        <ConfirmDialog
          title="Delete canvas?"
          message="This canvas moves to the Trash and is permanently deleted after 30 days. Its notes and tasks are untouched."
          confirmLabel="Delete canvas"
          onConfirm={async () => {
            await store.remove(canvas.id);
            setConfirmDelete(false);
            nav.back();
          }}
          onClose={() => setConfirmDelete(false)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surfaceApp },
  list: { paddingHorizontal: space.ml, paddingTop: space.ml, paddingBottom: FAB_CLEARANCE, flexGrow: 1 },
  titleSlot: { flex: 1, minWidth: 0 },
  body: { flex: 1, minHeight: 0 },
  board: { flex: 1, minHeight: 0 },
});
