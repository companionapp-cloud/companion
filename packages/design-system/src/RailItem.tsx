import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { noDragRegion, transition, type PressState } from "./platform";
import { Text } from "./Text";
import { colors, motion, radius } from "./tokens";

export interface RailItemProps {
  /** 16px glyph. */
  icon: ReactNode;
  label: string;
  active?: boolean;
  expanded?: boolean;
  /** Mono count shown at the row's trailing edge when expanded. */
  badge?: string;
  onPress?: () => void;
  /** A drag is resting on the item, about to open its view (spring-loading). */
  highlighted?: boolean;
}

/** One entry in the hover-reveal sidebar rail: a 28px icon square collapsed, an
 * icon + label row when the rail is expanded. Active uses the same soft-accent treatment
 * as a selected list row, so selection reads identically everywhere. */
export function RailItem({ icon, label, active, expanded, badge, onPress, highlighted }: RailItemProps) {
  return (
    <Pressable
      onPress={onPress}
      aria-label={label}
      style={({ hovered, pressed }: PressState) => [
        styles.item,
        noDragRegion,
        transition("background-color", motion.fast),
        {
          width: expanded ? "100%" : 28,
          paddingHorizontal: expanded ? 7 : 0,
          justifyContent: expanded ? "flex-start" : "center",
          backgroundColor: active || highlighted
            ? colors.accentSoft
            : pressed
              ? colors.surfaceActive
              : hovered
                ? colors.surfaceHover
                : "transparent",
        },
      ]}
    >
      <View style={styles.icon}>{icon}</View>
      {expanded ? (
        <>
          <Text variant="label" tone={active || highlighted ? "accent" : "secondary"} numberOfLines={1} style={styles.label}>
            {label}
          </Text>
          {badge ? (
            <Text variant="mono" tone="quaternary">
              {badge}
            </Text>
          ) : null}
        </>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 28,
    borderRadius: radius.sm,
    flexShrink: 0,
  },
  icon: { flexShrink: 0, alignItems: "center", justifyContent: "center" },
  label: { flex: 1, minWidth: 0 },
});
