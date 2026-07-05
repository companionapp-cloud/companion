import { Pressable, StyleSheet } from "react-native";
import { Icon } from "./Icon";
import { noDragRegion, type PressState } from "./platform";
import { Text } from "./Text";
import { colors, radius, space } from "./tokens";

export interface TabProps {
  label: string;
  active?: boolean;
  onPress?: () => void;
  onClose?: () => void;
}

/** A single document tab: title + close affordance. Active tabs read as a raised
 * card; inactive tabs are quiet until hovered. */
export function Tab({ label, active, onPress, onClose }: TabProps) {
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
      <Text
        variant="caption"
        tone={active ? "default" : "secondary"}
        numberOfLines={1}
        style={styles.label}
      >
        {label}
      </Text>
      {onClose ? (
        <Pressable
          onPress={onClose}
          aria-label="Close tab"
          style={({ hovered }: PressState) => [
            styles.close,
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
  close: { width: 18, height: 18, alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
});
