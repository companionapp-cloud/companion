import type { ReactNode } from "react";
import { Pressable, StyleSheet } from "react-native";
import { Icon } from "./Icon";
import { noDragRegion, transition, type PressState } from "./platform";
import { Text } from "./Text";
import { colors, motion, radius } from "./tokens";

export interface TabProps {
  label: string;
  active?: boolean;
  /** Optional leading 11–12px glyph (a note vs task vs view glyph). */
  icon?: ReactNode;
  onPress?: () => void;
  /** When provided, an expand affordance that pops the tab's document out to its own
   *  window/browser tab. */
  onExpand?: () => void;
  onClose?: () => void;
}

/** One tab in the workspace strip — a document or a view. Active reads as a raised panel
 * (card fill + hairline); inactive stays quiet until hovered. */
export function Tab({ label, active, icon, onPress, onExpand, onClose }: TabProps) {
  return (
    <Pressable
      onPress={onPress}
      role="tab"
      aria-selected={!!active}
      style={({ hovered }: PressState) => [
        noDragRegion,
        styles.tab,
        transition("background-color, border-color", motion.fast),
        {
          backgroundColor: active ? colors.surfaceCard : hovered ? colors.surfaceHover : "transparent",
          borderColor: active ? colors.borderSubtle : "transparent",
        },
      ]}
    >
      {icon}
      <Text variant="caption" tone={active ? "default" : "secondary"} numberOfLines={1} style={styles.label}>
        {label}
      </Text>
      {onExpand ? <Affordance label="Open in new window" icon="external" onPress={onExpand} /> : null}
      {onClose ? <Affordance label="Close tab" icon="close" onPress={onClose} /> : null}
    </Pressable>
  );
}

function Affordance({ label, icon, onPress }: { label: string; icon: "external" | "close"; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      aria-label={label}
      style={({ hovered }: PressState) => [
        styles.affordance,
        { backgroundColor: hovered ? colors.surfaceActive : "transparent" },
      ]}
    >
      <Icon name={icon} size={10} strokeWidth={2} color={colors.textTertiary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 24,
    maxWidth: 170,
    paddingLeft: 7,
    paddingRight: 3,
    borderRadius: radius.sm,
    borderWidth: 1,
    flexShrink: 0,
  },
  label: { flexShrink: 1 },
  affordance: { width: 16, height: 16, alignItems: "center", justifyContent: "center", borderRadius: radius.xs, flexShrink: 0 },
});
