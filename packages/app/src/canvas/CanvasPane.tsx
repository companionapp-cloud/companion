import { useEffect, useRef, useState } from "react";
import { Platform, TextInput, View } from "react-native";
import { Center, Icon, IconButton, Text, colors, font, icon, layout, row, space, useDensity } from "@companion/design-system";
import { ConfirmDialog } from "../ConfirmDialog";
import { MembershipPicker } from "../MembershipPicker";
import { useCanvases } from "./CanvasesProvider";
import { CanvasEditor } from "./CanvasEditor";
import type { CanvasRefKind } from "./host";

/** A board's detail pane: an editable name, the project-membership picker, delete, and the
 *  editor beneath. Shared by the root Canvases view and a project's Canvases section. The
 *  name row is a 28px sub-toolbar (44px under touch density); the board's own tool strip
 *  sits directly beneath it inside the editor. */
export function CanvasPane({ canvasId, onDeleted, onOpenRef }: { canvasId: string; onDeleted?: () => void; onOpenRef?: (ref: { type: CanvasRefKind; id: string }) => void }) {
  const store = useCanvases();
  const touch = useDensity() === "touch";
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
        <Text variant="caption" tone="tertiary">
          {store.loading ? "Loading…" : "This canvas is gone."}
        </Text>
      </Center>
    );
  }

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={[styles.header, touch ? styles.headerTouch : null]}>
        <Icon name="canvas" size={touch ? icon.md : icon.sm} color={colors.textQuaternary} />
        <TextInput
          value={draft}
          placeholder="Untitled canvas"
          placeholderTextColor={colors.textQuaternary}
          onChangeText={onChangeName}
          style={[styles.name, touch ? styles.nameTouch : null]}
        />
        <IconButton label="Projects" size={touch ? undefined : "sm"} active={showProjects} onPress={() => setShowProjects((v) => !v)}>
          <Icon name="folder" size={touch ? icon.lg : 13} color={showProjects ? colors.textAccent : colors.textSecondary} />
        </IconButton>
        <IconButton label="Delete canvas" size={touch ? undefined : "sm"} onPress={() => setConfirmDelete(true)}>
          <Icon name="trash" size={touch ? icon.lg : 13} color={colors.textSecondary} />
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
    height: layout.subToolbarH,
    paddingLeft: space.ml,
    paddingRight: space.sm,
    flexShrink: 0,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.surfaceCard,
  },
  headerTouch: { height: row.touch, paddingLeft: space.lg, gap: space.md },
  // The board's name, edited in place: borderless like a document field, but at the
  // sub-toolbar's 13px title weight rather than TextField's 30px display heading.
  name: {
    flex: 1,
    minWidth: 0,
    padding: 0,
    fontFamily: font.sans,
    fontSize: font.size.base,
    fontWeight: font.weight.semibold,
    color: colors.textPrimary,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as Record<string, unknown>) : null),
  },
  nameTouch: { fontSize: font.size.lg },
};
