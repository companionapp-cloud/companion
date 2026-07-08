import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { dragRegion } from "./platform";
import { Text } from "./Text";
import { colors, layout, radius, shadow, space } from "./tokens";

/** Toolbar sits directly on the gray canvas — no background, no border. It doubles
 * as a window drag handle on desktop (interactive children opt out via noDragRegion). */
export function Toolbar({ children }: { children?: ReactNode }) {
  return <View style={[styles.toolbar, dragRegion]}>{children}</View>;
}

/** Title lockup (icon + label) for a toolbar. */
export function FrameTitle({ icon, children }: { icon?: ReactNode; children?: ReactNode }) {
  return (
    <View style={styles.title}>
      {icon}
      <Text variant="title" numberOfLines={1}>
        {children}
      </Text>
    </View>
  );
}

/** Frame is the inset content surface: a blended toolbar over the canvas above a
 * floating white card (rounded, hairline border, soft shadow). */
export function Frame({ toolbar, children }: { toolbar?: ReactNode; children?: ReactNode }) {
  return (
    <View style={styles.frame}>
      {toolbar}
      <View style={styles.card}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, backgroundColor: colors.surfaceApp },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    height: layout.toolbarH,
    paddingHorizontal: space.xxl,
    flexShrink: 0,
    // Above the content card (a later sibling), so toolbar popovers (e.g. the
    // notifications bell) overlay it instead of sliding underneath.
    zIndex: 10,
  },
  title: { flexDirection: "row", alignItems: "center", gap: space.md, minWidth: 0 },
  card: {
    flex: 1,
    minHeight: 0,
    marginRight: space.md,
    marginBottom: space.md,
    marginLeft: space.md,
    backgroundColor: colors.surfaceCard,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.xl,
    overflow: "hidden",
    ...shadow.sm,
  },
});
