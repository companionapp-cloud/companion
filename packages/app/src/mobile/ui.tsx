import type { ReactNode } from "react";
import { Modal, Platform, Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import {
  Icon,
  IconButton,
  Text,
  colors,
  font,
  motion,
  radius,
  row,
  shadow,
  space,
  transition,
  type IconName,
  type PressState,
} from "@companion/design-system";
import { useNav } from "../nav-context";
import { useTourAnchor } from "../onboarding/anchors";

// Building blocks for the mobile *web* shell — a port of the native app's inset-grouped
// cards (apps/mobile/src/ui/native.tsx) minus the per-OS branches: on the web we always
// use the iOS-style hairline separators with a fill-on-press. Touch density throughout:
// 38px icon tiles, 60px minimum card rows, 14px gaps, 44px nav bars, a 56px FAB. Type,
// colour, radii and mono metadata are the desktop's.

/** Icon sizes used by mobile chrome: 18 in the nav bar, 20 in a tile, 19 for a bare
 * leading glyph. */
export const NAV_ICON = 18;
const TILE = 38;
const ROW_GAP = 14;
const ROW_ICON = 19;

/** A grouped container for rows — an inset card. Rows inside are contiguous, separated
 * by inset hairlines; never gap them. */
export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

/** A small uppercase mono section label (e.g. an area's name), sitting above a card.
 * `trailing` hosts the section's own actions across from the label. */
export function SectionLabel({ children, trailing, onPress }: { children: ReactNode; trailing?: ReactNode; onPress?: () => void }) {
  if (!trailing && !onPress) {
    return (
      <Text variant="eyebrow" tone="tertiary" numberOfLines={1} style={styles.sectionLabel}>
        {children}
      </Text>
    );
  }
  const label = (
    <Text variant="eyebrow" tone="tertiary" numberOfLines={1} style={onPress ? undefined : styles.sectionRowLabel}>
      {children}
    </Text>
  );
  return (
    <View style={styles.sectionRow}>
      {/* A tappable heading opens what it names (an area's page); the chevron says so. */}
      {onPress ? (
        <Pressable onPress={onPress} aria-label={typeof children === "string" ? `Open ${children}` : "Open"} style={styles.sectionRowPress}>
          {label}
          <Icon name="chevronRight" size={12} color={colors.textQuaternary} />
        </Pressable>
      ) : (
        label
      )}
      {trailing}
    </View>
  );
}

/** A 38px rounded-square icon tile. `accent` uses the soft accent wash; `neutral` the
 * sunken surface. */
export function IconTile({ children, variant = "neutral" }: { children: ReactNode; variant?: "accent" | "neutral" }) {
  return (
    <View style={[styles.tile, variant === "accent" ? styles.tileAccent : styles.tileNeutral]}>{children}</View>
  );
}

/** A mono count pill (e.g. a note count). Round because it is purely numeric. */
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
 * chevron. A hairline separator sits below every row but the last, inset past the leading
 * visual. */
export function CardRow({ leading, title, subtitle, trailing, showChevron = true, isLast, divided = true, separatorInset, onPress }: CardRowProps) {
  const sepLeft = separatorInset ?? (leading ? SEPARATOR_INSET : space.xl);
  return (
    <Pressable
      onPress={onPress}
      aria-label={title}
      style={({ hovered, pressed }: PressState) => [
        styles.row,
        transition("background-color", motion.instant),
        pressed ? styles.rowPressed : hovered && onPress ? styles.rowHover : null,
      ]}
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
      {showChevron ? <Icon name="chevronRight" size={NAV_ICON} color={colors.textTertiary} /> : null}
      {divided && !isLast ? <View style={[styles.separator, { left: sepLeft }]} /> : null}
    </Pressable>
  );
}

/** A bare 19px leading glyph for document lists (notes, chats, boards), where a tile per
 * row would be noise. Pair it with `separatorInset={ROW_ICON_INSET}`. */
export function RowIcon({ name, color = colors.textTertiary }: { name: IconName; color?: string }) {
  return <Icon name={name} size={ROW_ICON} color={color} />;
}

/** One row of a *virtualised* grouped list: draws the card's edges around a FlatList item
 * so the rows still read as one contiguous card (top corners on the first, bottom on the
 * last) without mounting every row inside a single Card. */
export function GroupedItem({ index, count, children }: { index: number; count: number; children: ReactNode }) {
  return (
    <View style={[styles.groupedItem, index === 0 ? styles.groupedFirst : null, index === count - 1 ? styles.groupedLast : null]}>
      {children}
    </View>
  );
}

/** The 22px touch checkbox: a 1.5px strong border, radius 3, accent fill and a white
 * check when on. Stops the press from reaching the row it sits in. */
export function Checkbox({ checked, onPress, label }: { checked: boolean; onPress: () => void; label?: string }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={11}
      aria-label={label ?? (checked ? "Mark not done" : "Mark done")}
      style={[styles.check, checked ? styles.checkOn : null]}
    >
      {checked ? <Icon name="check" size={13} color={colors.onAccent} strokeWidth={2.5} /> : null}
    </Pressable>
  );
}

/** The accent circular create button, floated over a screen's bottom-right corner. `anchor` makes
 *  it a tutorial anchor (it floats, so it can't be wrapped in one). */
export function Fab({ label, onPress, icon = "plus", anchor }: { label: string; onPress: () => void; icon?: IconName; anchor?: string }) {
  const anchorRef = useTourAnchor(anchor ?? "");
  // `ref` isn't in the shared RN typing's Pressable props, hence the spread.
  const refProps = (anchor ? { ref: anchorRef } : {}) as Record<string, unknown>;
  return (
    <Pressable
      {...refProps}
      onPress={onPress}
      aria-label={label}
      style={({ hovered, pressed }: PressState) => [
        styles.fab,
        transition("background-color", motion.instant),
        pressed ? styles.fabPressed : hovered ? styles.fabHover : null,
      ]}
    >
      <Icon name={icon} size={24} color={colors.onAccent} />
    </Pressable>
  );
}

/** The Card's own style, for hosts that must own the container view (a SortableList). */
export const cardStyle = () => styles.card;

/** Spacer that keeps a scroll view's last row clear of the FAB. */
export const FAB_CLEARANCE = 76;

export interface NavBarProps {
  title: string;
  /** Replaces the title text (e.g. a tap-to-rename field). */
  titleSlot?: ReactNode;
  /** Defaults to the shell navigator's back (which steps "up" on a deep link). */
  onBack?: () => void;
  /** Icon actions on the right — `lg` IconButtons with 18px icons. */
  right?: ReactNode;
  /** A segmented control, hosted below the title row where a phone expects one. */
  segments?: ReactNode;
}

/** The standard mobile nav bar: 44px on the app surface with a bottom hairline — back,
 * a truncating title, icon actions — and an optional segmented control beneath. */
export function NavBar({ title, titleSlot, onBack, right, segments }: NavBarProps) {
  const nav = useNav();
  return (
    <View style={styles.navBar}>
      <View style={styles.navRow}>
        <IconButton label="Back" size="lg" onPress={onBack ?? nav.back}>
          <Icon name="chevronLeft" size={NAV_ICON} color={colors.textSecondary} />
        </IconButton>
        {titleSlot ?? (
          <Text variant="title" numberOfLines={1} style={styles.navTitle}>
            {title}
          </Text>
        )}
        {right}
      </View>
      {segments ? <View style={styles.navSegments}>{segments}</View> : null}
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
  tone = "default",
}: {
  icon: IconName;
  label: string;
  onPress?: () => void;
  active?: boolean;
  disabled?: boolean;
  tone?: "default" | "danger";
}) {
  return (
    <IconButton label={label} size="lg" active={active} disabled={disabled} onPress={onPress}>
      <Icon name={icon} size={NAV_ICON} color={active ? colors.textAccent : tone === "danger" ? colors.danger : colors.textSecondary} />
    </IconButton>
  );
}

/** A bottom sheet over a scrim — where a phone puts anything secondary instead of a
 * toolbar. Overlay surface, 8px top corners, a small grab handle, safe-area bottom
 * padding. It appears in place: content never animates in. */
export function BottomSheet({ visible = true, onClose, children, padded = true }: { visible?: boolean; onClose: () => void; children: ReactNode; padded?: boolean }) {
  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} aria-label="Close" />
      <View style={[styles.sheet, padded ? styles.sheetPadded : styles.sheetTight, sheetAboveKeyboard]}>
        <View style={styles.grabber} />
        {children}
      </View>
    </Modal>
  );
}

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

// Bottom padding that clears the home indicator. env() is CSS, so only the web build gets
// it (react-native's types want a number; native sheets pad by their own safe-area inset).
// The web shell's --safe-bottom drops the inset while the keyboard covers the home indicator.
function safeBottom(px: number): ViewStyle {
  return Platform.OS === "web"
    ? ({ paddingBottom: `calc(${px}px + var(--safe-bottom, env(safe-area-inset-bottom, 0px)))` } as unknown as ViewStyle)
    : { paddingBottom: px };
}

// A sheet sits at the bottom of its modal, which is pinned to the layout viewport, and iOS
// slides its keyboard over that without resizing anything. So on the web the sheet stands on
// the part of the layout viewport the keyboard covers (the shell publishes it, see
// apps/web/src/viewportFit.ts; zero when there is no keyboard) and scrolls if the space left
// above the keyboard is shorter than it is. Native modals avoid the keyboard on their own.
const sheetAboveKeyboard =
  Platform.OS === "web"
    ? ({ marginBottom: "var(--vv-bottom, 0px)", maxHeight: "var(--vv-height, 100%)", overflowY: "auto" } as unknown as ViewStyle)
    : null;

// Separator starts past the leading tile so it reads as an inset-grouped list.
const SEPARATOR_INSET = space.xl + TILE + ROW_GAP;
/** The separator inset for rows led by a bare RowIcon. */
export const ROW_ICON_INSET = space.xl + ROW_ICON + ROW_GAP;
/** The separator inset for rows led by a Checkbox (flush with the row's text gutter). */
export const CHECKBOX_INSET = space.xl;

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    overflow: "hidden", // clip row press fills to the rounded corners
  },
  sectionLabel: { paddingHorizontal: space.sm, paddingTop: space.lg, paddingBottom: space.md },
  sectionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingLeft: space.sm,
    paddingTop: space.sm,
    paddingBottom: space.xxs,
    minHeight: 38,
  },
  sectionRowLabel: { flex: 1, minWidth: 0 },
  sectionRowPress: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.xs, alignSelf: "stretch" },
  tile: { width: TILE, height: TILE, borderRadius: radius.lg, alignItems: "center", justifyContent: "center", flexShrink: 0 },
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
  pillText: { fontSize: font.size.sm, fontWeight: font.weight.semibold },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: ROW_GAP,
    paddingHorizontal: space.xl,
    paddingVertical: 14,
    minHeight: 60,
  },
  rowHover: { backgroundColor: colors.surfaceHover },
  rowPressed: { backgroundColor: colors.surfaceActive },
  rowLeading: { flexShrink: 0 },
  rowBody: { flex: 1, minWidth: 0, gap: 1 },
  rowTitle: { fontSize: font.size.lg, color: colors.textPrimary },
  groupedItem: {
    backgroundColor: colors.surfaceCard,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: colors.borderSubtle,
    overflow: "hidden",
  },
  groupedFirst: { borderTopWidth: 1, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  groupedLast: { borderBottomWidth: 1, borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg },
  separator: { position: "absolute", bottom: 0, right: 0, height: 1, backgroundColor: colors.borderSubtle },
  check: {
    width: 22,
    height: 22,
    flexShrink: 0,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  checkOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  // The FAB is the one floating control on a phone: round, and lifted off the list.
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
    ...shadow.md,
  },
  fabHover: { backgroundColor: colors.accentHover },
  fabPressed: { backgroundColor: colors.accentActive },
  navBar: { flexShrink: 0, backgroundColor: colors.surfaceApp, borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  navRow: { flexDirection: "row", alignItems: "center", gap: space.xs, height: row.touch, paddingHorizontal: space.sm },
  navTitle: { flex: 1, minWidth: 0 },
  navSegments: { paddingHorizontal: space.md, paddingBottom: space.md },
  scrim: { flex: 1, backgroundColor: colors.scrim },
  sheet: {
    backgroundColor: colors.surfaceOverlay,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    paddingTop: space.md,
    ...shadow.lg,
  },
  // env() keeps the sheet's content clear of the home indicator in an installed PWA.
  sheetPadded: { paddingHorizontal: space.lg, ...safeBottom(12) },
  sheetTight: { paddingHorizontal: space.ml, ...safeBottom(14) },
  grabber: { width: 32, height: 3, borderRadius: radius.sm, backgroundColor: colors.borderDefault, alignSelf: "center", marginBottom: space.lg },
  emptyWrap: { alignItems: "center", gap: space.md, marginTop: 28, paddingHorizontal: space.xl2 },
  emptyText: { textAlign: "center", lineHeight: 18 },
});
