import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { dragRegion } from "./platform";
import { Text } from "./Text";
import { colors, layout, radius, space } from "./tokens";

/** The toolbar sits directly on the app canvas — no fill, no border. It doubles as a
 * window drag handle on desktop (interactive children opt out via noDragRegion).
 * `dense` is the 28px sub-toolbar used inside a panel. */
export function Toolbar({ children, dense = false }: { children?: ReactNode; dense?: boolean }) {
  return <View style={[styles.toolbar, dense ? styles.toolbarDense : dragRegion]}>{children}</View>;
}

/** Icon + label lockup for a toolbar or pane header. */
export function FrameTitle({ icon, children, trailing }: { icon?: ReactNode; children?: ReactNode; trailing?: ReactNode }) {
  return (
    <View style={styles.title}>
      {icon}
      <Text variant="title" numberOfLines={1} style={styles.titleText}>
        {children}
      </Text>
      {trailing}
    </View>
  );
}

/** The inset content surface: a blended toolbar over the canvas above a panel with a
 * hairline border and a 6px radius. No shadow — hairlines do the structural work. */
export function Frame({ toolbar, children, statusBar }: { toolbar?: ReactNode; children?: ReactNode; statusBar?: ReactNode }) {
  return (
    <View style={styles.frame}>
      {toolbar}
      <View style={styles.panel}>{children}</View>
      {statusBar}
    </View>
  );
}

/** Thin mono status strip (sync state, counts, version). Children are laid out in a row;
 * plain strings should be wrapped in `StatusText`. */
export function StatusBar({ children }: { children?: ReactNode }) {
  return <View style={styles.statusBar}>{children}</View>;
}

/** A run of mono status text for the StatusBar. */
export function StatusText({ children }: { children?: ReactNode }) {
  return (
    <Text variant="mono" tone="quaternary" numberOfLines={1}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, minWidth: 0, minHeight: 0, backgroundColor: colors.surfaceApp },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    height: layout.toolbarH,
    paddingHorizontal: space.lg,
    flexShrink: 0,
    // Above the content panel (a later sibling), so toolbar popovers (e.g. the
    // notifications bell) overlay it instead of sliding underneath.
    zIndex: 10,
  },
  toolbarDense: { height: layout.subToolbarH, paddingHorizontal: space.md },
  title: { flexDirection: "row", alignItems: "center", gap: space.sm, minWidth: 0 },
  titleText: { flexShrink: 1 },
  panel: {
    flex: 1,
    minHeight: 0,
    marginRight: space.lg,
    marginBottom: space.lg,
    marginLeft: space.lg,
    backgroundColor: colors.surfaceCard,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.lg,
    overflow: "hidden",
  },
  statusBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.ml,
    height: layout.statusbarH,
    paddingHorizontal: space.lg,
    flexShrink: 0,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.surfaceApp,
  },
});

