import type { ReactNode } from "react";
import { Platform, Pressable, StyleSheet, View, type GestureResponderEvent } from "react-native";
import { useDensity } from "./Density";
import { Icon } from "./Icon";
import { noSelect, transition, type PressState } from "./platform";
import { Text } from "./Text";
import { colors, icon as iconSize, motion, radius, row, space } from "./tokens";

export interface ListRowProps {
  title: string;
  subtitle?: string;
  /** Leading 12px glyph. Pass it `--text-4` quiet; it should turn accent when selected. */
  icon?: ReactNode;
  /** Trailing mono metadata (relative time, a count). */
  trailing?: string;
  /** A control pinned to the row's far right (a drag handle). Shown only while the row is
   *  hovered, so a list doesn't read as a wall of grips; always visible without hover. */
  accessory?: ReactNode;
  selected?: boolean;
  hasChildren?: boolean;
  /** Tree depth; each level indents 12px. */
  indent?: number;
  onPress?: (e: GestureResponderEvent) => void;
  /** Web: a right-click on the row (its context menu). react-native-web hands it to the DOM. */
  onContextMenu?: (event: { preventDefault(): void; stopPropagation(): void; clientX?: number; clientY?: number }) => void;
}

/** Selectable row for browse lists (notes, tasks, boards, projects). 24px single-line,
 * 38px only when a subtitle earns it; touch surfaces never drop below 44px. */
export function ListRow({ title, subtitle, icon, trailing, accessory, selected, hasChildren, indent = 0, onPress, onContextMenu }: ListRowProps) {
  const density = useDensity();
  const minHeight = density === "touch" ? row.touch : subtitle ? row.twoLine : row.h;
  return (
    <Pressable
      onPress={onPress}
      // Not in every React Native typing (only react-native-web forwards it), so passed untyped.
      {...(onContextMenu ? ({ onContextMenu } as object) : null)}
      style={({ hovered, pressed }: PressState) => [
        styles.row,
        noSelect,
        transition("background-color", motion.fast),
        {
          minHeight,
          paddingLeft: space.sm + indent * 12,
          backgroundColor: selected
            ? colors.surfaceSelected
            : pressed
              ? colors.surfaceActive
              : hovered
                ? colors.surfaceHover
                : "transparent",
        },
      ]}
    >
      {(({ hovered }: PressState) => (
        <>
          {icon ? <View style={styles.icon}>{icon}</View> : null}
          <View style={styles.body}>
            <Text variant="label" tone={selected ? "accent" : "default"} numberOfLines={1}>
              {title}
            </Text>
            {subtitle ? (
              <Text variant="caption" tone="tertiary" numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          {trailing ? (
            <Text variant="mono" tone="quaternary" style={styles.trailing}>
              {trailing}
            </Text>
          ) : null}
          {hasChildren ? <Icon name="chevronRight" size={iconSize.sm} color={colors.textQuaternary} /> : null}
          {accessory ? <View style={[styles.accessory, { opacity: hovered || !canHover ? 1 : 0 }]}>{accessory}</View> : null}
        </>
      )) as unknown as ReactNode}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingRight: space.sm,
    borderRadius: radius.sm,
  },
  icon: { flexShrink: 0 },
  body: { flex: 1, minWidth: 0, justifyContent: "center", gap: 1 },
  trailing: { flexShrink: 0 },
  accessory: { flexShrink: 0 },
});

// Hover only exists with a pointer; touch platforms keep hover-revealed controls visible.
const canHover = Platform.OS === "web" && typeof window !== "undefined" && !!window.matchMedia?.("(hover: hover)").matches;
