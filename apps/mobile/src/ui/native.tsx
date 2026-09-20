import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackHeaderProps } from '@react-navigation/native-stack';
import { Icon, IconButton, Text, colors, font, radius, row, shadow, space, type IconName, type PressState } from '@companion/design-system';

// OS-native building blocks for the mobile UI — the native twin of the mobile web kit
// (packages/app/src/mobile/ui.tsx), same names and props. Touch density throughout: 38px
// icon tiles, 60px minimum card rows, 14px gaps, 44px nav bars, a 56px FAB, and hairline
// separators inset past the leading tile. Press feedback is a fill (iOS highlight) or the
// platform ripple (Android) — nothing scales or moves. Everything is driven by the shared
// design tokens; on native those are light-theme literals.

const isIOS = Platform.OS === 'ios';

/** Icon size for nav-bar actions. */
export const NAV_ICON = 18;
const TILE = 38;
const ROW_GAP = 14;
const ROW_ICON = 19;

/** A grouped container for rows — one contiguous inset card, hairline only, no shadow. */
export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

/** A small uppercase mono section label (e.g. an area's name), sitting above a card.
 * `trailing` hosts the section's own actions across from the label. */
export function SectionLabel({
  children,
  leading,
  trailing,
  onPress,
}: {
  children: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Opens what the heading names (an area's page). */
  onPress?: () => void;
}) {
  if (!trailing && !leading && !onPress) {
    return (
      <Text variant="eyebrow" tone="tertiary" numberOfLines={1} style={styles.sectionLabel}>
        {children}
      </Text>
    );
  }
  return (
    <View style={styles.sectionRow}>
      {leading}
      {onPress ? (
        <Pressable onPress={onPress} accessibilityRole="button" style={styles.sectionRowPress}>
          <Text variant="eyebrow" tone="tertiary" numberOfLines={1}>
            {children}
          </Text>
          <Icon name="chevronRight" size={12} color={colors.textQuaternary} />
        </Pressable>
      ) : (
        <Text variant="eyebrow" tone="tertiary" numberOfLines={1} style={styles.sectionRowLabel}>
          {children}
        </Text>
      )}
      {trailing}
    </View>
  );
}

/** A 38px rounded-square icon tile. `accent` uses the soft accent wash; `neutral` the
 * sunken surface. */
export function IconTile({ children, variant = 'neutral' }: { children: ReactNode; variant?: 'accent' | 'neutral' }) {
  return (
    <View style={[styles.tile, variant === 'accent' ? styles.tileAccent : styles.tileNeutral]}>{children}</View>
  );
}

/** A mono count pill (e.g. a note count). Numeric counts are the one fully-round chip. */
export function CountPill({ children }: { children: ReactNode }) {
  return (
    <View style={styles.pill}>
      <Text variant="mono" tone="secondary" style={styles.pillText}>
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
  /** Draw a hairline separator below the row (default true). */
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
  const sepLeft = separatorInset ?? (leading ? SEPARATOR_INSET : space.xl);
  return (
    <Pressable
      onPress={onPress}
      android_ripple={onPress ? { color: colors.surfaceActive } : undefined}
      style={({ pressed }: PressState) => [styles.row, isIOS && pressed && onPress ? styles.rowPressed : null]}
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

/** The bare 19px leading icon of a document row (a note, a board, a chat). */
export function RowIcon({ name, color = colors.textTertiary }: { name: IconName; color?: string }) {
  return <Icon name={name} size={ROW_ICON} color={color} />;
}

/** One row's slice of a grouped card, for virtualised lists: FlatList items can't share a
 * single `Card` wrapper, so each wears the card's sides and the first and last close it.
 * The rows still read as one contiguous card. */
export function GroupedItem({ index, count, children }: { index: number; count: number; children: ReactNode }) {
  return (
    <View style={[styles.groupedItem, index === 0 ? styles.groupedFirst : null, index === count - 1 ? styles.groupedLast : null]}>
      {children}
    </View>
  );
}

/** The 22px touch checkbox that leads a task row: 1.5px strong border, radius 3, accent
 * fill with a white check when done. */
export function Checkbox({ checked, onPress, label }: { checked: boolean; onPress: () => void; label?: string }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={11}
      aria-label={label ?? (checked ? 'Mark not done' : 'Mark done')}
      style={[styles.check, checked ? styles.checkOn : null]}
    >
      {checked ? <Icon name="check" size={13} color={colors.onAccent} strokeWidth={2.5} /> : null}
    </Pressable>
  );
}

/** The accent circular create button, floated over a screen's bottom-right corner. Pass
 * `bottomInset` where the screen runs to the bottom edge (no tab bar beneath it). */
export function Fab({ label, onPress, icon = 'plus', bottomInset = 0 }: { label: string; onPress: () => void; icon?: IconName; bottomInset?: number }) {
  return (
    <Pressable
      onPress={onPress}
      aria-label={label}
      style={({ pressed }: PressState) => [styles.fab, { bottom: space.xl + bottomInset, backgroundColor: pressed ? colors.accentActive : colors.accent }]}
    >
      <Icon name={icon} size={24} color={colors.onAccent} />
    </Pressable>
  );
}

/** Clearance to leave under a list so its last row scrolls out from behind the FAB. */
export const FAB_CLEARANCE = 76;

/** A centred caption for an empty list or a placeholder section. */
export function EmptyCaption({ children, icon }: { children: ReactNode; icon?: IconName }) {
  return (
    <View style={styles.emptyWrap}>
      {icon ? <Icon name={icon} size={20} color={colors.textQuaternary} /> : null}
      <Text variant="caption" tone="tertiary" style={styles.emptyText}>
        {children}
      </Text>
    </View>
  );
}

/* ---------------- Nav bar ---------------- */

export interface NavBarProps {
  title?: string;
  /** Replaces the title text (e.g. a two-line project title). */
  titleSlot?: ReactNode;
  onBack?: () => void;
  /** Right-side icon actions (`lg` IconButtons, 18px icons). */
  right?: ReactNode;
  /** A segmented control, hosted below the title row where a phone expects one. */
  segments?: ReactNode;
  /** Draw the bottom hairline (default true). A stack screen that hangs `NavBarSegments`
   * under the bar turns this off so the hairline sits beneath the segments instead. */
  hairline?: boolean;
}

/** The 44px nav bar every pushed screen wears: back, a 15px semibold title, icon actions,
 * on `surfaceApp` with a hairline. It carries the top safe-area inset itself. */
export function NavBar({ title, titleSlot, onBack, right, segments, hairline = true }: NavBarProps) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.navBar, { paddingTop: insets.top }, hairline ? styles.navHairline : null]}>
      <View style={styles.navRow}>
        {onBack ? (
          <IconButton label="Back" size="lg" onPress={onBack}>
            <Icon name="chevronLeft" size={NAV_ICON} color={colors.textSecondary} />
          </IconButton>
        ) : (
          <View style={styles.navNoBack} />
        )}
        <View style={styles.navTitle}>
          {titleSlot ?? (
            <Text variant="title" numberOfLines={1}>
              {title ?? ''}
            </Text>
          )}
        </View>
        {right}
      </View>
      {segments ? <View style={styles.navSegmentsInner}>{segments}</View> : null}
    </View>
  );
}

/** A nav-bar icon action: an `lg` IconButton around an 18px icon. */
export function NavAction({
  icon,
  label,
  onPress,
  active,
  disabled,
  tone = 'default',
}: {
  icon: IconName;
  label: string;
  onPress?: () => void;
  active?: boolean;
  disabled?: boolean;
  tone?: 'default' | 'danger';
}) {
  return (
    <IconButton label={label} size="lg" active={active} disabled={disabled} onPress={onPress}>
      <Icon name={icon} size={NAV_ICON} color={active ? colors.textAccent : tone === 'danger' ? colors.danger : colors.textSecondary} />
    </IconButton>
  );
}

/** Adapts `NavBar` to the native stack's `header` option, so screens keep configuring it
 * the usual way (`title`, `headerTitle`, `headerRight`, `headerShadowVisible`). */
export function stackHeader({ navigation, options, route, back }: NativeStackHeaderProps) {
  const headerTitle = options.headerTitle;
  const title = typeof headerTitle === 'string' ? headerTitle : (options.title ?? route.name);
  return (
    <NavBar
      title={title}
      titleSlot={typeof headerTitle === 'function' ? headerTitle({ children: title, tintColor: colors.textPrimary }) : undefined}
      onBack={back ? navigation.goBack : undefined}
      right={options.headerRight ? options.headerRight({ tintColor: colors.textSecondary, canGoBack: !!back }) : undefined}
      hairline={options.headerShadowVisible !== false}
    />
  );
}

/** A row of right-side nav bar actions. */
export function NavActions({ children }: { children: ReactNode }) {
  return <View style={styles.navActions}>{children}</View>;
}

/** The nav bar's lower storey: a segmented control below the title row — where the
 * platform puts one — closing the bar with its hairline. Pair with
 * `headerShadowVisible: false` on the screen. Wide controls scroll sideways. */
export function NavBarSegments({ children, detached }: { children: ReactNode; detached?: boolean }) {
  // `detached`: the bar above already closed with its own hairline (a project's tab),
  // so the strip pads its top like any sub-toolbar.
  return <View style={[styles.navSegments, detached ? styles.navSegmentsDetached : null]}>{children}</View>;
}

/* ---------------- Bottom sheet ---------------- */

/** The sheet's drawn surface over a scrim, filling its parent. Used directly where the
 * content must stay in the screen's own view tree; otherwise reach for `BottomSheet`. */
export function SheetSurface({ onClose, children, padded = true, maxHeight }: { onClose: () => void; children: ReactNode; padded?: boolean; maxHeight?: number | `${number}%` }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.sheetRoot}>
      <Pressable style={styles.scrim} onPress={onClose} aria-label="Close" />
      <View style={[styles.sheet, padded ? styles.sheetPadded : null, { paddingBottom: insets.bottom + space.lg, maxHeight }]}>
        <View style={styles.grabber} />
        {children}
      </View>
    </View>
  );
}

/** A bottom sheet for anything secondary (capture, embed pickers, metadata): scrim, an
 * overlay surface with an 8px top radius, a grab handle and safe-area bottom padding.
 * It appears in place — content never animates in. */
export function BottomSheet({ visible, onClose, children, padded, maxHeight }: { visible: boolean; onClose: () => void; children: ReactNode; padded?: boolean; maxHeight?: number | `${number}%` }) {
  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.sheetRoot} behavior={isIOS ? 'padding' : undefined}>
        <SheetSurface onClose={onClose} padded={padded} maxHeight={maxHeight}>
          {children}
        </SheetSurface>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// Separator starts past the leading tile so it reads as an iOS inset-grouped list.
const SEPARATOR_INSET = space.xl + TILE + ROW_GAP;
/** The separator inset for rows led by a bare RowIcon. */
export const ROW_ICON_INSET = space.xl + ROW_ICON + ROW_GAP;
/** The separator inset for rows led by a Checkbox (flush with the row's text gutter). */
export const CHECKBOX_INSET = space.xl;

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    overflow: 'hidden', // clip row ripples / press highlights to the rounded corners
  },
  sectionLabel: { paddingHorizontal: space.sm, paddingTop: space.lg, paddingBottom: space.md },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingLeft: space.sm,
    paddingTop: space.sm,
    paddingBottom: space.xxs,
    minHeight: 38,
  },
  sectionRowLabel: { flex: 1, minWidth: 0 },
  sectionRowPress: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: space.xs, alignSelf: 'stretch' },
  tile: { width: TILE, height: TILE, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
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
  pillText: { fontSize: font.size.sm, fontWeight: font.weight.semibold },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ROW_GAP,
    paddingHorizontal: space.xl,
    paddingVertical: 14,
    minHeight: 60,
  },
  rowPressed: { backgroundColor: colors.surfaceHover },
  rowLeading: { flexShrink: 0 },
  rowBody: { flex: 1, minWidth: 0, gap: 1 },
  rowTitle: { fontSize: font.size.lg, color: colors.textPrimary },
  separator: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
  },
  groupedItem: {
    backgroundColor: colors.surfaceCard,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    overflow: 'hidden',
  },
  groupedFirst: { borderTopWidth: StyleSheet.hairlineWidth, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  groupedLast: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg },
  check: {
    width: 22,
    height: 22,
    flexShrink: 0,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  fab: {
    position: 'absolute',
    right: space.xl,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    // The one floating control on a screen, so it takes the popover elevation.
    ...shadow.md,
  },
  emptyWrap: { alignItems: 'center', gap: space.md, marginTop: 28, paddingHorizontal: space.xl2 },
  emptyText: { textAlign: 'center', lineHeight: 18 },
  navBar: { backgroundColor: colors.surfaceApp },
  navHairline: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSubtle },
  navRow: { height: row.touch, flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingHorizontal: space.sm },
  navNoBack: { width: space.sm },
  navTitle: { flex: 1, minWidth: 0 },
  navActions: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  navSegments: {
    paddingHorizontal: space.md,
    paddingBottom: space.md,
    backgroundColor: colors.surfaceApp,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  navSegmentsInner: { paddingHorizontal: space.md, paddingBottom: space.md },
  navSegmentsDetached: { paddingTop: space.md },
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.scrim },
  sheet: {
    backgroundColor: colors.surfaceOverlay,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    paddingTop: space.md,
    ...shadow.lg,
  },
  sheetPadded: { paddingHorizontal: space.lg },
  grabber: { width: 32, height: 3, borderRadius: 3, backgroundColor: colors.borderDefault, alignSelf: 'center', marginBottom: space.lg },
});
