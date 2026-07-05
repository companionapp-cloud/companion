import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { noDragRegion, type PressState } from "./platform";
import { Text } from "./Text";
import { colors, radius, space } from "./tokens";

export interface RailItemProps {
  icon: ReactNode;
  label: string;
  active?: boolean;
  expanded?: boolean;
  onPress?: () => void;
}

/** A single item in the hover-reveal sidebar rail. Collapses to a 40px square icon;
 * shows its label when the rail is expanded. */
export function RailItem({ icon, label, active, expanded, onPress }: RailItemProps) {
  return (
    <Pressable
      onPress={onPress}
      aria-label={label}
      style={({ hovered }: PressState) => [
        styles.item,
        noDragRegion,
        {
          width: expanded ? "100%" : 40,
          paddingHorizontal: expanded ? space.lg : 0,
          justifyContent: expanded ? "flex-start" : "center",
          backgroundColor: active ? colors.accentSoft : hovered ? colors.surfaceHover : "transparent",
        },
      ]}
    >
      <View style={styles.icon}>{icon}</View>
      {expanded ? (
        <Text variant="label" tone={active ? "accent" : "secondary"} numberOfLines={1}>
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.lg,
    height: 40,
    borderRadius: radius.lg,
  },
  icon: { flexShrink: 0, alignItems: "center", justifyContent: "center" },
});
