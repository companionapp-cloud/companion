import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text, colors, font, radius, space, type PressState } from '@companion/design-system';

// OS-native building blocks for the mobile UI. Same information architecture as the
// Companion Android reference, but the surfaces adapt per platform: iOS reads as an
// inset-grouped table (hairline separators, highlight-on-press), Android as a Material
// card (ripple-on-press). Everything is driven by the shared design tokens.

const isIOS = Platform.OS === 'ios';

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
export function IconTile({ children, variant = 'neutral' }: { children: ReactNode; variant?: 'accent' | 'neutral' }) {
  return (
    <View style={[styles.tile, variant === 'accent' ? styles.tileAccent : styles.tileNeutral]}>{children}</View>
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
 * chevron. Press feedback is platform-native (iOS highlight / Android ripple). A
 * hairline separator sits below every row but the last, inset past the leading visual
 * (iOS convention). */
export function CardRow({ leading, title, subtitle, trailing, showChevron = true, isLast, divided = true, separatorInset, onPress }: CardRowProps) {
  const sepLeft = separatorInset ?? (leading ? SEPARATOR_INSET : space.md);
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: colors.surfaceActive }}
      style={({ pressed }: PressState) => [styles.row, isIOS && pressed ? { backgroundColor: colors.surfaceHover } : null]}
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

// Separator starts past the leading tile so it reads as an iOS inset-grouped list.
const SEPARATOR_INSET = space.md + 38 + 14;

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceCard,
    // Slightly rounder on Android (Material) than iOS's grouped-table radius.
    borderRadius: isIOS ? radius.lg : radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    overflow: 'hidden', // clip row ripples / press highlights to the rounded corners
  },
  sectionLabel: {
    fontSize: 10,
    letterSpacing: 1.2,
    color: colors.textTertiary,
    paddingHorizontal: space.sm,
    paddingTop: space.lg,
    paddingBottom: space.sm,
    textTransform: 'uppercase',
  },
  tile: { width: 38, height: 38, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  tileAccent: { backgroundColor: colors.accentSoft },
  tileNeutral: { backgroundColor: colors.surfaceSunken },
  pill: {
    minWidth: 26,
    paddingHorizontal: space.md,
    paddingVertical: 3,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceSunken,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillText: { fontSize: 12, color: colors.textSecondary, fontWeight: font.weight.semibold },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: space.xl,
    paddingVertical: 14,
    minHeight: 60,
  },
  rowLeading: { flexShrink: 0 },
  rowBody: { flex: 1, minWidth: 0, gap: 1 },
  rowTitle: { fontSize: 15, color: colors.textPrimary },
  separator: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
  },
});
