import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Text } from "./Text";
import { colors, radius, space } from "./tokens";

/** Centers its children in the available space — empty states, loaders. */
export function Center({ children, style }: { children?: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.center, style]}>{children}</View>;
}

/** Hairline rule. `vertical` separates toolbar groups; give it a height via `style`. */
export function Divider({ vertical = false, style }: { vertical?: boolean; style?: StyleProp<ViewStyle> }) {
  return <View style={[vertical ? styles.dividerVertical : styles.divider, style]} />;
}

/** Mono keyboard hint (⌘T, ⌥⇧␣). Shortcuts are documented in the UI, not hidden in a
 * help page. */
export function Kbd({ children }: { children?: ReactNode }) {
  return (
    <View style={styles.kbd}>
      <Text variant="mono" tone="secondary">
        {children}
      </Text>
    </View>
  );
}

type Justify = "start" | "center" | "end" | "between";
type Align = "start" | "center" | "end" | "stretch";

interface FlexProps {
  children?: ReactNode;
  gap?: number;
  justify?: Justify;
  align?: Align;
  style?: StyleProp<ViewStyle>;
}

// `as const` so the values are literal unions (real react-native's ViewStyle types
// justifyContent/alignItems as string literals, not plain string).
const justifyMap = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
} as const;
const alignMap = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
} as const;

/** Row lays children out horizontally. */
export function Row({ children, gap, justify, align, style }: FlexProps) {
  return (
    <View
      style={[
        { flexDirection: "row", gap, justifyContent: justify && justifyMap[justify], alignItems: align && alignMap[align] },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** Stack lays children out vertically. */
export function Stack({ children, gap, justify, align, style }: FlexProps) {
  return (
    <View
      style={[
        { flexDirection: "column", gap, justifyContent: justify && justifyMap[justify], alignItems: align && alignMap[align] },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, minHeight: 0, alignItems: "center", justifyContent: "center", gap: space.md, padding: space.xxl },
  divider: { height: 1, backgroundColor: colors.borderSubtle, flexShrink: 0 },
  dividerVertical: { width: 1, alignSelf: "stretch", backgroundColor: colors.borderSubtle, flexShrink: 0 },
  kbd: {
    flexDirection: "row",
    alignItems: "center",
    height: 16,
    paddingHorizontal: space.xs,
    backgroundColor: colors.surfaceSunken,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.xs,
    flexShrink: 0,
  },
});
