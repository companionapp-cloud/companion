import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, Text, colors, font, radius, space, type PressState } from "@companion/design-system";

// Building blocks for the mobile *web* shell — a port of the native app's inset-grouped
// cards (apps/mobile/src/ui/native.tsx) minus the per-OS branches: on the web we always
// use the iOS-style hairline separators with a highlight-on-press.

/** A grouped container for rows — an inset card. */
export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

/** A small uppercase mono section label (e.g. AREAS), sitting above a card. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <Text variant="mono" style={styles.sectionLabel}>
      {children}
    </Text>
  );
}

/** A 38px rounded-square icon tile. `accent` uses the soft accent wash; `neutral` the
 * sunken surface. */
export function IconTile({ children, variant = "neutral" }: { children: ReactNode; variant?: "accent" | "neutral" }) {
  return (
    <View style={[styles.tile, variant === "accent" ? styles.tileAccent : styles.tileNeutral]}>{children}</View>
  );
}

/** A mono count pill (e.g. a note count). */
export function CountPill({ children }: { children: ReactNode }) {
  return (
    <View style={styles.pill}>
      <Text variant="mono" style={styles.pillText}>
        {children}
      </Text>
    </View>
  );
}

export interface CardRowProps {
  leading?: ReactNode;
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  showChevron?: boolean;
  isLast?: boolean;
  /** Draw a hairline separator below the row (default true). False for flat, gapped lists. */
  divided?: boolean;
  /** Left offset of the hairline separator; defaults to align past a 38px icon tile. */
  separatorInset?: number;
  onPress?: () => void;
}

/** A single row inside a Card: leading visual, title/subtitle, optional trailing and a
 * chevron. A hairline separator sits below every row but the last, inset past the leading
 * visual. */
export function CardRow({ leading, title, subtitle, trailing, showChevron = true, isLast, divided = true, separatorInset, onPress }: CardRowProps) {
  const sepLeft = separatorInset ?? (leading ? SEPARATOR_INSET : space.md);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }: PressState) => [styles.row, pressed ? { backgroundColor: colors.surfaceHover } : null]}
    >
      {leading ? <View style={styles.rowLeading}>{leading}</View> : null}
      <View style={styles.rowBody}>
        <Text variant="label" numberOfLines={1} style={styles.rowTitle}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" tone="tertiary" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
      {showChevron ? <Icon name="chevronRight" size={18} color={colors.textTertiary} /> : null}
      {divided && !isLast ? <View style={[styles.separator, { left: sepLeft }]} /> : null}
    </Pressable>
  );
}

/** The accent circular create button, floated over a screen's bottom-right corner. */
export function Fab({ label, onPress, icon = "plus" }: { label: string; onPress: () => void; icon?: "plus" }) {
  return (
    <Pressable style={styles.fab} onPress={onPress} aria-label={label}>
      <Icon name={icon} size={24} color={colors.textInverse} />
    </Pressable>
  );
}

// Separator starts past the leading tile so it reads as an inset-grouped list.
const SEPARATOR_INSET = space.md + 38 + 14;

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    overflow: "hidden", // clip row press highlights to the rounded corners
  },
  sectionLabel: {
    fontSize: 10,
    letterSpacing: 1.2,
    color: colors.textTertiary,
    paddingHorizontal: space.sm,
    paddingTop: space.lg,
    paddingBottom: space.sm,
    textTransform: "uppercase",
  },
  tile: { width: 38, height: 38, borderRadius: radius.lg, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  tileAccent: { backgroundColor: colors.accentSoft },
  tileNeutral: { backgroundColor: colors.surfaceSunken },
  pill: {
    minWidth: 26,
    paddingHorizontal: space.md,
    paddingVertical: 3,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSunken,
    alignItems: "center",
    justifyContent: "center",
  },
  pillText: { fontSize: 12, color: colors.textSecondary, fontWeight: font.weight.semibold },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: space.xl,
    paddingVertical: 14,
    minHeight: 60,
  },
  rowLeading: { flexShrink: 0 },
  rowBody: { flex: 1, minWidth: 0, gap: 1 },
  rowTitle: { fontSize: 15, color: colors.textPrimary },
  separator: {
    position: "absolute",
    bottom: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
  },
  fab: {
    position: "absolute",
    right: space.xl,
    bottom: space.xl,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
});
