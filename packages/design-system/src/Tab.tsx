import type { ReactNode } from "react";
import { Pressable, StyleSheet } from "react-native";
import { Icon } from "./Icon";
import { noDragRegion, type PressState } from "./platform";
import { Text } from "./Text";
import { colors, radius, space } from "./tokens";

export interface TabProps {
  label: string;
  active?: boolean;
  /** Optional leading icon (e.g. a note vs task glyph). */
  icon?: ReactNode;
  onPress?: () => void;
  /** When provided, an expand affordance that pops the tab's document out to its own
   *  window/browser tab. */
  onExpand?: () => void;
  onClose?: () => void;
}

/** A single document tab: optional type icon, title, and expand/close affordances. Active
 * tabs read as a raised card; inactive tabs are quiet until hovered. */
export function Tab({ label, active, icon, onPress, onExpand, onClose }: TabProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ hovered }: PressState) => [
        noDragRegion,
        styles.tab,
        {
          backgroundColor: active ? colors.surfaceCard : hovered ? colors.surfaceHover : "transparent",
          borderColor: active ? colors.borderSubtle : "transparent",
        },
      ]}
    >
      {icon}
      <Text
        variant="caption"
        tone={active ? "default" : "secondary"}
        numberOfLines={1}
        style={styles.label}
      >
        {label}
      </Text>
      {onExpand ? (
        <Pressable
          onPress={onExpand}
          aria-label="Open in new window"
          style={({ hovered }: PressState) => [
            styles.affordance,
            { backgroundColor: hovered ? colors.surfaceActive : "transparent" },
          ]}
        >
          <Icon name="external" size={12} color={colors.textTertiary} />
        </Pressable>
      ) : null}
      {onClose ? (
        <Pressable
          onPress={onClose}
          aria-label="Close tab"
          style={({ hovered }: PressState) => [
            styles.affordance,
            { backgroundColor: hovered ? colors.surfaceActive : "transparent" },
          ]}
        >
          <Icon name="close" size={13} color={colors.textTertiary} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    height: 30,
    maxWidth: 180,
    paddingLeft: space.md,
    paddingRight: space.xs,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  label: { flexShrink: 1 },
  affordance: { width: 18, height: 18, alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
});
