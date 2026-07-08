import type { ReactNode } from "react";
import { View } from "react-native";
import { Text, colors, radius, shadow, space } from "@companion/design-system";

/** The multiselect preview: the first selected item (`children`) rendered on top of a
 *  couple of offset "cards" to suggest a stack, with a count badge. Shown in the detail
 *  pane while ≥2 items are selected (PLAN §3). */
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
        <Text variant="caption" tone="accent" style={{ fontWeight: "600" }}>
          {count} selected
        </Text>
      </View>
    </View>
  );
}

const OFFSET = 10;

const styles = {
  root: { flex: 1, minHeight: 0, backgroundColor: colors.surfaceApp, padding: space.xl },
  // Room on the right/bottom for the peeking card edges.
  stage: { flex: 1, minHeight: 0, marginRight: OFFSET * 2, marginBottom: OFFSET * 2 },
  card: {
    position: "absolute" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
  },
  card1: { transform: [{ translateX: OFFSET }, { translateY: OFFSET }] },
  card2: { transform: [{ translateX: OFFSET * 2 }, { translateY: OFFSET * 2 }], opacity: 0.6 },
  // The top card holds the live editor; clip it and lift it above the peeking layers.
  top: { overflow: "hidden" as const, ...shadow.lg },
  badge: {
    position: "absolute" as const,
    top: space.xl + space.md,
    left: space.xl + space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.full,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accentSoftBorder,
    zIndex: 1,
  },
};
