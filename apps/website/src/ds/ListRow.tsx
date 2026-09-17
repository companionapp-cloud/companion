import type { ReactNode } from "react";
import { Pressable, StyleSheet, View, type GestureResponderEvent } from "react-native";
import { Icon } from "./Icon";
import { type PressState } from "./platform";
import { Text } from "./Text";
import { colors, radius, space } from "./tokens";

export interface ListRowProps {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  trailing?: string;
  selected?: boolean;
  hasChildren?: boolean;
  onPress?: (e: GestureResponderEvent) => void;
}

/** Selectable row for navigation lists (folders, notes). Two-line when a subtitle
 * is present; shows a chevron affordance when it drills into children. */
export function ListRow({ title, subtitle, icon, trailing, selected, hasChildren, onPress }: ListRowProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ hovered }: PressState) => [
        styles.row,
        { backgroundColor: selected ? colors.accentSoft : hovered ? colors.surfaceHover : "transparent" },
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
        <Text variant="mono" tone="tertiary">
          {trailing}
        </Text>
      ) : null}
      {hasChildren ? <Icon name="chevronRight" size={16} color={colors.textTertiary} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 38,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
  },
  icon: { flexShrink: 0 },
  body: { flex: 1, minWidth: 0, justifyContent: "center" },
});
