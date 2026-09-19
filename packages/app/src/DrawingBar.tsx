import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Button, Divider, Icon, IconButton, colors, control, layout, radius, row, space, useDensity } from "@companion/design-system";
import type { IconName, PressState } from "@companion/design-system";
import { INK_COLORS, type InkColor, type InkSize, type InkState, type InkTool, type InkToolKind } from "@companion/editor";

// Drawing on notes (PLAN-drawing.md): the toolbar shown in place of the formatting bar while a
// note is in drawing mode — tool, colour, size, undo/redo, and Done. Plain React Native, so the
// same bar serves web, desktop and the native app.

const TOOLS: { kind: InkToolKind; icon: IconName; label: string }[] = [
  { kind: "pen", icon: "pen", label: "Pen" },
  { kind: "highlighter", icon: "highlighter", label: "Highlighter" },
  { kind: "eraser", icon: "eraser", label: "Eraser" },
];

// Swatches use the same theme roles the editor paints ink with (packages/editor styles.ts).
const SWATCH: Record<InkColor, string> = {
  ink: colors.textPrimary,
  red: colors.danger,
  orange: colors.accent,
  yellow: colors.warning,
  green: colors.success,
  blue: colors.info,
};
const COLOR_LABEL: Record<InkColor, string> = {
  ink: "Ink",
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
};
const SIZES: { size: InkSize; dot: number; label: string }[] = [
  { size: 0, dot: 4, label: "Thin" },
  { size: 1, dot: 7, label: "Medium" },
  { size: 2, dot: 10, label: "Thick" },
];

interface ToolPrefs {
  kind: InkToolKind;
  pen: { color: InkColor; size: InkSize };
  highlighter: { color: InkColor; size: InkSize };
  eraser: { size: InkSize };
}

// Remembered for the session across notes, so reopening drawing picks up the last pen.
let remembered: ToolPrefs = {
  kind: "pen",
  pen: { color: "ink", size: 1 },
  highlighter: { color: "yellow", size: 1 },
  eraser: { size: 1 },
};

export type InkToolPatch = Partial<Pick<InkTool, "kind" | "color" | "size">>;

/** The active drawing tool, with each tool keeping its own colour and size (a yellow
 *  highlighter and a black pen, not one shared colour). */
export function useDrawingTool(): [InkTool, (patch: InkToolPatch) => void] {
  const [prefs, setPrefs] = useState(remembered);
  const tool = useMemo<InkTool>(() => {
    if (prefs.kind === "eraser") return { kind: "eraser", color: "ink", size: prefs.eraser.size };
    const p = prefs[prefs.kind];
    return { kind: prefs.kind, color: p.color, size: p.size };
  }, [prefs]);
  const update = useCallback((patch: InkToolPatch) => {
    setPrefs((prev) => {
      const kind = patch.kind ?? prev.kind;
      const next: ToolPrefs = { ...prev, kind };
      if (kind === "eraser") {
        if (patch.size !== undefined) next.eraser = { size: patch.size };
      } else {
        next[kind] = { color: patch.color ?? prev[kind].color, size: patch.size ?? prev[kind].size };
      }
      remembered = next;
      return next;
    });
  }, []);
  return [tool, update];
}

export function DrawingBar({
  tool,
  onChange,
  state,
  onUndo,
  onRedo,
  onDone,
}: {
  tool: InkTool;
  onChange: (patch: InkToolPatch) => void;
  state: InkState | null;
  onUndo: () => void;
  onRedo: () => void;
  onDone: () => void;
}) {
  const touch = useDensity() === "touch";
  const size = touch ? "lg" : "sm";
  const glyph = touch ? 17 : 13;
  const hit = touch ? control.lg + 6 : control.sm;

  const controls = (
    <>
      {TOOLS.map((t) => {
        const active = tool.kind === t.kind;
        return (
          <IconButton key={t.kind} label={t.label} size={size} active={active} onPress={() => onChange({ kind: t.kind })}>
            <Icon name={t.icon} size={glyph} color={active ? colors.textAccent : colors.textSecondary} />
          </IconButton>
        );
      })}
      <Divider vertical style={styles.divider} />
      {tool.kind !== "eraser"
        ? INK_COLORS.map((c) => {
            const active = tool.color === c;
            return (
              <Pressable
                key={c}
                aria-label={`${COLOR_LABEL[c]} ink`}
                aria-selected={active}
                onPress={() => onChange({ color: c })}
                style={[styles.option, { width: hit, height: hit }]}
              >
                <View
                  style={[
                    styles.swatchRing,
                    { width: hit - 6, height: hit - 6, borderColor: active ? colors.borderFocus : "transparent" },
                  ]}
                >
                  <View style={[styles.swatch, { width: hit - 12, height: hit - 12, backgroundColor: SWATCH[c] }]} />
                </View>
              </Pressable>
            );
          })
        : null}
      {tool.kind !== "eraser" ? <Divider vertical style={styles.divider} /> : null}
      {SIZES.map((s) => {
        const active = tool.size === s.size;
        return (
          <Pressable
            key={s.size}
            aria-label={s.label}
            aria-selected={active}
            onPress={() => onChange({ size: s.size })}
            style={({ hovered }: PressState) => [
              styles.option,
              { width: hit, height: hit, backgroundColor: active ? colors.accentSoft : hovered ? colors.surfaceHover : "transparent" },
            ]}
          >
            <View
              style={{
                width: s.dot,
                height: s.dot,
                borderRadius: s.dot / 2,
                backgroundColor: active ? colors.textAccent : colors.textSecondary,
              }}
            />
          </Pressable>
        );
      })}
      <Divider vertical style={styles.divider} />
      <IconButton label="Undo drawing" size={size} disabled={!state?.canUndo} onPress={onUndo}>
        <Icon name="undo" size={glyph} color={colors.textSecondary} />
      </IconButton>
      <IconButton label="Redo drawing" size={size} disabled={!state?.canRedo} onPress={onRedo}>
        <Icon name="redo" size={glyph} color={colors.textSecondary} />
      </IconButton>
    </>
  );

  if (touch) {
    return (
      <View style={[styles.bar, styles.barTouch]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.touchContent} style={{ flex: 1 }}>
          {controls}
        </ScrollView>
        <View style={styles.done}>
          <Button variant="ghost" size="md" label="Done" onPress={onDone} />
        </View>
      </View>
    );
  }
  return (
    <View style={[styles.bar, styles.barPointer]}>
      {controls}
      <View style={{ flex: 1 }} />
      <Button variant="ghost" size="sm" label="Done" kbd="esc" onPress={onDone} />
    </View>
  );
}

const styles = {
  bar: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    flexShrink: 0,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.surfaceApp,
  },
  barPointer: { height: layout.subToolbarH, gap: 1, paddingHorizontal: space.sm },
  barTouch: { height: row.touch, backgroundColor: colors.surfaceCard },
  touchContent: { alignItems: "center" as const, gap: space.xxs, paddingHorizontal: space.sm },
  done: { paddingHorizontal: space.sm, justifyContent: "center" as const },
  divider: { alignSelf: "center" as const, height: 12, marginHorizontal: space.xs },
  option: { alignItems: "center" as const, justifyContent: "center" as const, borderRadius: radius.sm },
  swatchRing: { borderRadius: 999, borderWidth: 1.5, alignItems: "center" as const, justifyContent: "center" as const },
  swatch: { borderRadius: 999 },
};
