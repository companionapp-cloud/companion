import { StyleSheet, View } from "react-native";
import { Text, type TextTone } from "./Text";
import { colors, radius } from "./tokens";

export type BadgeTone = "neutral" | "accent" | "danger" | "info";

export interface BadgeProps {
  label: string;
  tone?: BadgeTone;
  /** Fully round — only for pure numeric counts. Everything else is a 3px-cornered chip. */
  round?: boolean;
}

/** Mono chip for counts, versions and metadata — never for a status a user can act on. */
export function Badge({ label, tone = "neutral", round = false }: BadgeProps) {
  const t = tones[tone];
  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: t.bg, borderColor: t.border, borderRadius: round ? radius.full : radius.sm },
        round ? styles.round : null,
      ]}
    >
      <Text variant="mono" tone={t.fg} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const tones: Record<BadgeTone, { bg: string; border: string; fg: TextTone }> = {
  neutral: { bg: colors.surfaceSunken, border: colors.borderSubtle, fg: "tertiary" },
  accent: { bg: colors.accentSoft, border: colors.accentSoftBorder, fg: "accent" },
  danger: { bg: colors.dangerSoft, border: "transparent", fg: "danger" },
  info: { bg: colors.infoSoft, border: "transparent", fg: "info" },
};

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 16,
    paddingHorizontal: 5,
    borderWidth: 1,
    // center in a row (vertical) and shrink-to-content in a column (horizontal)
    alignSelf: "center",
    flexShrink: 0,
  },
  round: { minWidth: 16 },
});
