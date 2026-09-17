import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { ObjectProps } from "@companion/core-bridge";
import { Icon, IconButton, Text, colors, control, layout, radius, row, shadow, space, useDensity, type IconName, type PressState } from "@companion/design-system";
import { useObjectTypes } from "./ObjectTypesProvider";
import { ObjectForm } from "./ObjectForm";

/** The inline archetype chip for a note/task editor (PLAN §6.3): shows/sets the object
 *  type. A neutral, badge-style "+ add type" chip opens a picker; once typed, it shows the type with a
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
  const touch = useDensity() === "touch";
  const active = objectTypes.byId(objectTypeId);
  const candidates = objectTypes.forKind(kind);

  // No archetype: a ghost chip that opens a picker. Always shown (even with no types yet)
  // so making a note/task an object is discoverable; an empty picker points to Settings.
  if (!objectTypeId) {
    return (
      <View style={styles.wrap}>
        <Pressable
          onPress={() => setPicking((v) => !v)}
          aria-label="Add type"
          style={({ hovered, pressed }: PressState) => [
            styles.chip,
            touch ? styles.chipTouch : null,
            hovered ? { backgroundColor: colors.surfaceHover } : null,
            pressed || picking ? { backgroundColor: colors.surfaceActive } : null,
          ]}
        >
          <Text variant="mono" tone="tertiary">
            + add type
          </Text>
        </Pressable>
        {picking ? (
          <View style={styles.dropdown}>
            {candidates.length === 0 ? (
              <View style={[styles.dropdownRow, { paddingVertical: space.xs }]}>
                <Text variant="caption" tone="tertiary" style={{ flex: 1 }}>
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
                  style={({ hovered, pressed }: PressState) => [
                    styles.dropdownRow,
                    touch ? styles.dropdownRowTouch : null,
                    hovered ? { backgroundColor: colors.surfaceHover } : null,
                    pressed ? { backgroundColor: colors.surfaceActive } : null,
                  ]}
                >
                  <Text variant="label" numberOfLines={1}>
                    {t.name}
                  </Text>
                  <Text variant="mono" tone="quaternary">
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
    <View style={[styles.chip, touch ? styles.chipTouch : null]}>
      <Icon
        name={(active?.schemaJson.icon as IconName) || "file"}
        size={11}
        color={active?.schemaJson.color || colors.textAccent}
      />
      <Text variant="mono" tone="secondary" numberOfLines={1}>
        {active?.name ?? "unknown type"}
      </Text>
      <Pressable onPress={onClearType} aria-label="Remove type" hitSlop={touch ? 10 : 3} style={styles.clear}>
        <Icon name="close" size={10} color={colors.textQuaternary} />
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
        <Icon name={(active.schemaJson.icon as IconName) || "file"} size={12} color={active.schemaJson.color || colors.textAccent} />
        <Text variant="label" tone="secondary">
          {active.name}
        </Text>
      </View>
      <ObjectForm schema={active.schemaJson} props={props ?? {}} onChange={onChangeProps} />
    </View>
  );
}

const PANEL_MIN = 220;
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
  const [width, setWidth] = usePersistentWidth("companion.metadataPanel.width", layout.panelW);

  return (
    <View style={[styles.sidePanel, { width }]}>
      <ResizeHandle width={width} setWidth={setWidth} />
      <View style={styles.sidePanelHeader}>
        <Text variant="eyebrow" tone="quaternary" style={{ flex: 1 }}>
          Metadata
        </Text>
        <IconButton label="Hide metadata" size="sm" onPress={onClose}>
          <Icon name="close" size={12} color={colors.textTertiary} />
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
  // The chip anchors the picker; keep it above sibling chips so the floating dropdown
  // (absolutely positioned below) paints over them instead of pushing them around.
  wrap: { alignSelf: "center" as const, position: "relative" as const, zIndex: 1 },
  // Badge-style: 16px tall mono on the sunken fill, radius 3. Touch grows it to a 30px control.
  chip: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xs,
    alignSelf: "center" as const,
    height: 16,
    paddingHorizontal: 5,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surfaceSunken,
    flexShrink: 0,
  },
  chipTouch: { height: control.lg, paddingHorizontal: space.ml },
  clear: { padding: 3, marginVertical: -3, marginRight: -3 },
  metaHeader: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.xs },
  // A right pane on the panel surface, split from the document by a left hairline.
  sidePanel: {
    flexShrink: 0,
    borderLeftWidth: 1,
    borderLeftColor: colors.borderSubtle,
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
  // The eyebrow label and the close affordance share a row at the top of the panel's padding.
  sidePanelHeader: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xs,
    minHeight: control.sm,
    paddingTop: space.ml,
    paddingLeft: space.ml,
    paddingRight: space.sm,
  },
  sidePanelBody: { padding: space.ml, paddingTop: space.sm },
  // Floats below the chip so opening it never changes the chip's footprint (which would
  // otherwise shove the meta line / resize neighboring task chips). A popover, so it takes
  // the overlay surface and shadow.md.
  dropdown: {
    position: "absolute" as const,
    top: "100%" as const,
    left: 0,
    marginTop: space.xs,
    zIndex: 10,
    minWidth: 200,
    padding: space.xs,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceOverlay,
    ...shadow.md,
  },
  dropdownRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    gap: space.md,
    minHeight: row.h,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
  },
  dropdownRowTouch: { minHeight: row.touch },
};
