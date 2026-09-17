import type { ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import {
  Icon,
  Text,
  colors,
  control,
  font,
  icon as iconSize,
  motion,
  radius,
  row,
  shadow,
  space,
  swatches,
  transition,
  useDensity,
  type IconName,
  type PressState,
} from "@companion/design-system";

// The small form vocabulary the settings sections (and quick capture) share: a labelled
// field, a segmented switch, a swatch picker, a checkbox row and a code block. The design
// system deliberately has no Select / Switch / Radio, so these stay in the app layer.

/** A labelled field: 13px label, an optional tertiary help line, then the control(s). */
export function SettingsField({ label, help, children }: { label: string; help?: ReactNode; children?: ReactNode }) {
  return (
    <View style={styles.field}>
      <View style={styles.fieldHead}>
        <Text variant="label">{label}</Text>
        {help ? (
          <Text variant="caption" tone="tertiary">
            {help}
          </Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

/** A caption paragraph — section blurbs and footnotes. */
export function SettingsNote({ children, tone = "tertiary" }: { children?: ReactNode; tone?: "secondary" | "tertiary" | "danger" }) {
  return (
    <Text variant="caption" tone={tone}>
      {children}
    </Text>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  /** Accessibility label when the visible label alone is ambiguous. */
  ariaLabel?: string;
}

/** A segmented switch: a sunken hairline track whose selected segment is a raised card.
 *  22px segments with a pointer, 38px (a 44px track) under touch density. `fill` stretches
 *  the segments across the row; otherwise the track hugs its labels. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  fill = false,
}: {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  fill?: boolean;
}) {
  const touch = useDensity() === "touch";
  return (
    <View style={[styles.track, fill ? null : styles.trackHug]}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            aria-label={o.ariaLabel ?? o.label}
            style={({ hovered, pressed }: PressState) => [
              styles.segment,
              transition("background-color", motion.instant),
              { height: touch ? 38 : control.sm, paddingHorizontal: touch ? space.lg : space.md },
              fill ? styles.segmentFill : null,
              selected ? styles.segmentSelected : pressed ? styles.segmentPressed : hovered ? styles.segmentHover : null,
            ]}
          >
            {o.icon ? <Icon name={o.icon} size={touch ? 13 : iconSize.sm} color={selected ? colors.textPrimary : colors.textTertiary} /> : null}
            <Text
              variant="label"
              tone={selected ? "default" : "secondary"}
              numberOfLines={1}
              style={[{ fontSize: touch ? font.size.base : font.size.sm }, selected ? styles.segmentLabelSelected : null]}
            >
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The ten shared categorical swatches as small squares. `onChange(undefined)` fires when
 *  the selected swatch is pressed again and `clearable` is set. */
export function SwatchPicker({
  value,
  onChange,
  clearable = false,
}: {
  value?: string | null;
  onChange: (color: string | undefined) => void;
  clearable?: boolean;
}) {
  const touch = useDensity() === "touch";
  const dim = touch ? 30 : 16;
  return (
    <View style={[styles.swatchRow, { gap: touch ? space.md : space.sm }]}>
      {swatches.map((c) => {
        const selected = value === c;
        return (
          <Pressable
            key={c}
            onPress={() => onChange(selected && clearable ? undefined : c)}
            aria-label={`Color ${c}`}
            hitSlop={touch ? 7 : 2}
            style={[styles.swatch, { width: dim, height: dim, backgroundColor: c, borderRadius: touch ? radius.sm : radius.xs }]}
          >
            {selected ? <Icon name="check" size={touch ? 16 : 10} color={colors.onAccent} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** The system checkbox: 1px strong border, 2px radius, accent fill + white check when on.
 *  14px with a pointer, 22px under touch. With a `label` the whole row is the target. */
export function CheckBox({
  checked,
  onPress,
  label,
  ariaLabel,
}: {
  checked: boolean;
  onPress: () => void;
  label?: string;
  ariaLabel?: string;
}) {
  const touch = useDensity() === "touch";
  const dim = touch ? 22 : 14;
  return (
    <Pressable
      onPress={onPress}
      aria-label={ariaLabel ?? label}
      hitSlop={touch ? 11 : 4}
      style={[styles.checkRow, touch && label ? { minHeight: row.touch } : null]}
    >
      <View style={[styles.check, { width: dim, height: dim }, checked ? styles.checkOn : null]}>
        {checked ? <Icon name="check" size={touch ? 15 : 10} color={colors.onAccent} /> : null}
      </View>
      {label ? (
        <Text variant="caption" tone="secondary">
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** A shell snippet or a one-time code: mono on the code surface, scrolls sideways rather
 *  than wrapping. */
export function CodeBlock({ children }: { children: string }) {
  return (
    <View style={styles.code}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.codeInner}>
        <Text variant="mono" tone="secondary" style={styles.codeText}>
          {children}
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = {
  field: { gap: space.sm },
  fieldHead: { gap: 1 },
  track: {
    flexDirection: "row" as const,
    gap: space.xxs,
    padding: space.xxs,
    backgroundColor: colors.surfaceSunken,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.md,
  },
  trackHug: { alignSelf: "flex-start" as const },
  segment: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: space.xs,
    borderRadius: radius.sm,
  },
  segmentFill: { flex: 1 },
  segmentHover: { backgroundColor: colors.surfaceHover },
  segmentPressed: { backgroundColor: colors.surfaceActive },
  segmentSelected: { backgroundColor: colors.surfaceCard, ...shadow.sm },
  segmentLabelSelected: { fontWeight: font.weight.semibold },
  swatchRow: { flexDirection: "row" as const, flexWrap: "wrap" as const },
  swatch: { alignItems: "center" as const, justifyContent: "center" as const },
  checkRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm, alignSelf: "flex-start" as const },
  check: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.xs,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    flexShrink: 0,
  },
  checkOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  code: {
    backgroundColor: colors.surfaceCode,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.md,
  },
  codeInner: { paddingVertical: space.md, paddingHorizontal: space.ml },
  codeText: { fontSize: font.size.sm, lineHeight: 18 },
};
