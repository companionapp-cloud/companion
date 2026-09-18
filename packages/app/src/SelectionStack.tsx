import type { ReactNode } from "react";
import { View } from "react-native";
import { Text, colors, radius, space } from "@companion/design-system";

/** The multiselect preview: the first selected item (`children`) rendered on top of a
 *  couple of offset hairline panels to suggest a stack, with a mono count. Flat — the offset
 *  edges do the work, nothing is shadowed. Shown in the detail pane while ≥2 items are
 *  selected (PLAN §3). */
export function SelectionStack({ count, children }: { count: number; children: ReactNode }) {
  return (
    <View style={styles.root}>
      <View style={styles.stage}>
        {/* Offset layers behind the top card. Rendered first so they paint underneath. */}
        <View style={[styles.card, styles.card2]} />
        <View style={[styles.card, styles.card1]} />
        <View style={[styles.card, styles.top]}>{children}</View>
      </View>
      <View style={styles.badge}>
        <Text variant="mono" tone="accent">
          {count} selected
        </Text>
      </View>
    </View>
  );
}

const OFFSET = 6;

const styles = {
  root: { flex: 1, minHeight: 0, backgroundColor: colors.surfaceSunken, padding: space.lg },
  // Room on the right/bottom for the peeking card edges.
  stage: { flex: 1, minHeight: 0, marginRight: OFFSET * 2, marginBottom: OFFSET * 2 },
  card: {
    position: "absolute" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  card1: { transform: [{ translateX: OFFSET }, { translateY: OFFSET }] },
  card2: { transform: [{ translateX: OFFSET * 2 }, { translateY: OFFSET * 2 }] },
  // The top panel holds the live editor; clip it to the panel radius.
  top: { overflow: "hidden" as const },
  // Straddles the top panel's upper hairline, centred, so it never sits on the editor's
  // own sub-toolbar controls.
  badge: {
    position: "absolute" as const,
    top: space.lg - 8,
    alignSelf: "center" as const,
    height: 16,
    justifyContent: "center" as const,
    paddingHorizontal: 5,
    borderRadius: radius.sm,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accentSoftBorder,
    zIndex: 1,
  },
};
