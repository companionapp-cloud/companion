import type { ReactNode } from "react";
import { Pressable, StyleSheet, View, type GestureResponderEvent } from "react-native";
import { useDensity } from "./Density";
import { Icon } from "./Icon";
import { transition, type PressState } from "./platform";
import { Text } from "./Text";
import { colors, icon as iconSize, motion, radius, row, space } from "./tokens";

export interface ListRowProps {
  title: string;
  subtitle?: string;
  /** Leading 12px glyph. Pass it `--text-4` quiet; it should turn accent when selected. */
  icon?: ReactNode;
  /** Trailing mono metadata (relative time, a count). */
  trailing?: string;
  selected?: boolean;
  hasChildren?: boolean;
  /** Tree depth; each level indents 12px. */
  indent?: number;
  onPress?: (e: GestureResponderEvent) => void;
}

/** Selectable row for browse lists (notes, tasks, boards, projects). 24px single-line,
 * 38px only when a subtitle earns it; touch surfaces never drop below 44px. */
export function ListRow({ title, subtitle, icon, trailing, selected, hasChildren, indent = 0, onPress }: ListRowProps) {
  const density = useDensity();
  const minHeight = density === "touch" ? row.touch : subtitle ? row.twoLine : row.h;
  return (
    <Pressable
      onPress={onPress}
      style={({ hovered, pressed }: PressState) => [
        styles.row,
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
});
