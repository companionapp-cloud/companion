import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { colors, space } from "./tokens";

/** Center centers its children in the available space. */
export function Center({ children }: { children?: ReactNode }) {
  return <View style={styles.center}>{children}</View>;
}

/** A thin hairline divider. */
export function Divider() {
  return <View style={styles.divider} />;
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
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.md },
  divider: { height: 1, backgroundColor: colors.borderSubtle },
});
