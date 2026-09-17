import { StyleSheet, View } from "react-native";
import { Text } from "./Text";
import { colors, radius, space } from "./tokens";

export type BadgeTone = "neutral" | "accent";

export interface BadgeProps {
  label: string;
  tone?: BadgeTone;
}

/** Small pill for counts and metadata (e.g. "2 links"). */
export function Badge({ label, tone = "neutral" }: BadgeProps) {
  const accent = tone === "accent";
  return (
    <View
      style={[
        styles.badge,
        {
          backgroundColor: accent ? colors.accentSoft : colors.surfaceSunken,
          borderColor: accent ? colors.accentSoftBorder : colors.borderSubtle,
        },
      ]}
    >
      <Text variant="mono" tone={accent ? "accent" : "tertiary"}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.md,
    paddingVertical: space.xs / 2,
    borderRadius: radius.full,
    borderWidth: 1,
    // center in a row (vertical) and shrink-to-content in a column (horizontal)
    alignSelf: "center",
  },
});
