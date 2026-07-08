import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { ObjectProps } from "@companion/core-bridge";
import { Icon, IconButton, Text, colors, radius, space, type IconName, type PressState } from "@companion/design-system";
import { useObjectTypes } from "./ObjectTypesProvider";
import { ObjectForm } from "./ObjectForm";

/** The inline archetype chip for a note/task editor (PLAN §6.3): shows/sets the object
 *  type. A ghost "Add type" chip opens a picker; once typed, it shows the type with a
 *  clear (✕). Viewing/editing the type's structured props happens in the metadata side
 *  panel ({@link MetadataSidePanel}), not here — the chip is only the type selector. */
export function ArchetypeChip({
  kind,
  objectTypeId,
  onSetType,
  onClearType,
}: {
  kind: "note" | "task";
  objectTypeId?: string | null;
  onSetType: (typeId: string) => void;
  onClearType: () => void;
}) {
  const objectTypes = useObjectTypes();
  const [picking, setPicking] = useState(false);
  const active = objectTypes.byId(objectTypeId);
  const candidates = objectTypes.forKind(kind);

  // No archetype: a ghost chip that opens a picker. Always shown (even with no types yet)
  // so making a note/task an object is discoverable; an empty picker points to Settings.
  if (!objectTypeId) {
    return (
      <View style={styles.wrap}>
        <Pressable onPress={() => setPicking((v) => !v)} style={styles.ghostChip}>
          <Icon name="file" size={13} color={colors.textTertiary} />
          <Text variant="caption" tone="tertiary">
            Add type
          </Text>
        </Pressable>
        {picking ? (
          <View style={styles.dropdown}>
            {candidates.length === 0 ? (
              <View style={styles.dropdownRow}>
                <Text variant="caption" tone="tertiary">
                  No object types yet — create one in Settings → Objects.
                </Text>
              </View>
            ) : (
              candidates.map((t) => (
                <Pressable
                  key={t.id}
                  onPress={() => {
                    onSetType(t.id);
                    setPicking(false);
                  }}
                  style={({ hovered }: PressState) => [styles.dropdownRow, hovered ? { backgroundColor: colors.surfaceHover } : null]}
                >
                  <Text variant="caption">{t.name}</Text>
                  <Text variant="caption" tone="tertiary">
                    {t.appliesTo}
                  </Text>
                </Pressable>
              ))
            )}
          </View>
        ) : null}
      </View>
    );
  }

  // Archetyped: a filled chip with the type's icon + name and a clear (✕). A dangling type
  // (deleted/not synced) still lets the user clear it, tolerating the dangle (PLAN §5.1).
  return (
    <View style={[styles.typeChip, active ? styles.typeChipActive : null]}>
      <Icon
        name={(active?.schemaJson.icon as IconName) || "file"}
        size={13}
        color={active?.schemaJson.color || colors.accentHover}
      />
      <Text variant="caption" tone="secondary" style={{ fontWeight: "600" }}>
        {active?.name ?? "Unknown type"}
      </Text>
      <Pressable onPress={onClearType} aria-label="Remove type" style={styles.clear}>
        <Icon name="close" size={12} color={colors.textTertiary} />
      </Pressable>
    </View>
  );
}

/** The structured-props form for the note/task's object type (PLAN §6.3). Rendered in the
 *  metadata side panel and — on mobile, where there's no side panel — inline. Shows a hint
 *  when no type is set, or when the type isn't available on this device. */
export function ObjectMetadataPanel({
  objectTypeId,
  props,
  onChangeProps,
}: {
  objectTypeId?: string | null;
  props?: ObjectProps;
  onChangeProps: (next: ObjectProps) => void;
}) {
  const objectTypes = useObjectTypes();
  const active = objectTypes.byId(objectTypeId);

  if (!objectTypeId) {
    return (
      <Text variant="caption" tone="tertiary">
        Add a type with the chip beside the title to give this a structured set of fields.
      </Text>
    );
  }
  if (!active) {
    return (
      <Text variant="caption" tone="tertiary">
        This type isn’t available on this device yet.
      </Text>
    );
  }
  return (
    <View style={{ gap: space.md }}>
      <View style={styles.metaHeader}>
        <Icon name={(active.schemaJson.icon as IconName) || "file"} size={14} color={active.schemaJson.color || colors.accentHover} />
        <Text variant="caption" tone="secondary" style={{ fontWeight: "600" }}>
          {active.name}
        </Text>
      </View>
      <ObjectForm schema={active.schemaJson} props={props ?? {}} onChange={onChangeProps} />
    </View>
  );
}

const PANEL_MIN = 240;
const PANEL_MAX = 560;

/** The metadata side panel to the right of a note/task's content, toggled from the editor
 *  sub-toolbar. A titled, scrollable column that hosts {@link ObjectMetadataPanel}, with a
 *  draggable left edge — its width persists across sessions. */
export function MetadataSidePanel({
  objectTypeId,
  props,
  onChangeProps,
  onClose,
}: {
  objectTypeId?: string | null;
  props?: ObjectProps;
  onChangeProps: (next: ObjectProps) => void;
  onClose: () => void;
}) {
  const [width, setWidth] = usePersistentWidth("companion.metadataPanel.width", 320);

  return (
    <View style={[styles.sidePanel, { width }]}>
      <ResizeHandle width={width} setWidth={setWidth} />
      <View style={styles.sidePanelHeader}>
        <Text variant="caption" tone="tertiary" style={{ fontWeight: "600", letterSpacing: 0.5, flex: 1 }}>
          METADATA
        </Text>
        <IconButton label="Hide metadata" size="sm" onPress={onClose}>
          <Icon name="close" size={15} color={colors.textTertiary} />
        </IconButton>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.sidePanelBody}>
        <ObjectMetadataPanel objectTypeId={objectTypeId} props={props} onChangeProps={onChangeProps} />
      </ScrollView>
    </View>
  );
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** The draggable left edge of the metadata panel. Dragging left widens the panel (it sits
 *  on the right); the content pane flexes to absorb the change. Web/desktop only — the panel
 *  never renders on native. Mirrors design-system's SplitView divider. */
function ResizeHandle({ width, setWidth }: { width: number; setWidth: (n: number) => void }) {
  const [active, setActive] = useState(false);
  const drag = useRef({ startX: 0, startW: 0 });

  const onMove = useCallback(
    (e: PointerEvent) => {
      // Panel is on the right, so moving the pointer left (smaller clientX) widens it.
      const next = drag.current.startW + (drag.current.startX - e.clientX);
      setWidth(clamp(next, PANEL_MIN, PANEL_MAX));
    },
    [setWidth],
  );

  const onUp = useCallback(() => {
    setActive(false);
    if (typeof window === "undefined") return;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  }, [onMove]);

  const onDown = useCallback(
    (e: { clientX?: number; nativeEvent?: { clientX?: number } }) => {
      if (typeof window === "undefined") return;
      const clientX = e?.nativeEvent?.clientX ?? e?.clientX ?? 0;
      drag.current = { startX: clientX, startW: width };
      setActive(true);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [width, onMove, onUp],
  );

  // Drop listeners if we unmount mid-drag.
  useEffect(
    () => () => {
      if (typeof window === "undefined") return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    },
    [onMove, onUp],
  );

  return (
    <View
      onPointerDown={onDown}
      onPointerEnter={() => setActive(true)}
      onPointerLeave={() => setActive(false)}
      aria-label="Resize metadata panel"
      style={styles.handle}
    >
      <View style={[styles.handleLine, active ? styles.handleLineActive : null]} />
    </View>
  );
}

function usePersistentWidth(key: string, initial: number) {
  const [width, setWidthState] = useState<number>(() => {
    if (typeof window === "undefined") return initial;
    try {
      const stored = window.localStorage?.getItem(key);
      const n = stored == null ? NaN : Number(stored);
      return Number.isFinite(n) ? clamp(n, PANEL_MIN, PANEL_MAX) : initial;
    } catch {
      return initial;
    }
  });
  const setWidth = useCallback(
    (next: number) => {
      setWidthState(next);
      if (typeof window === "undefined") return;
      try {
        window.localStorage?.setItem(key, String(Math.round(next)));
      } catch {
        /* storage unavailable */
      }
    },
    [key],
  );
  return [width, setWidth] as const;
}

const styles = {
  wrap: { gap: space.xs, alignSelf: "flex-start" as const },
  ghostChip: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xs,
    alignSelf: "flex-start" as const,
    paddingHorizontal: space.md,
    paddingVertical: 5,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  typeChip: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xs,
    alignSelf: "flex-start" as const,
    paddingHorizontal: space.md,
    paddingVertical: 5,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.gray50,
  },
  typeChipActive: { backgroundColor: colors.accentSoft, borderColor: colors.accentSoftBorder },
  clear: { padding: 3, marginVertical: -3, marginRight: -3 },
  metaHeader: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.xs },
  sidePanel: {
    flexShrink: 0,
    borderLeftWidth: 1,
    borderLeftColor: colors.borderSubtle,
    backgroundColor: colors.surfaceApp,
    position: "relative" as const,
  },
  // A 7px hit area straddling the panel's left seam; the 1px line stays centered on it.
  handle: {
    position: "absolute" as const,
    left: -4,
    top: 0,
    bottom: 0,
    width: 7,
    zIndex: 1,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    cursor: "col-resize" as unknown as "auto",
  },
  handleLine: { width: 1, height: "100%" as const, backgroundColor: "transparent" as const },
  handleLineActive: { backgroundColor: colors.accent },
  sidePanelHeader: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xs,
    height: 44,
    paddingLeft: space.lg,
    paddingRight: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  sidePanelBody: { padding: space.lg },
  dropdown: {
    alignSelf: "flex-start" as const,
    minWidth: 180,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceCard,
    overflow: "hidden" as const,
  },
  dropdownRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
};
