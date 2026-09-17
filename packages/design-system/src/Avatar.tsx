import { StyleSheet, Text, View } from "react-native";
import { colors, font, radius } from "./tokens";

export interface AvatarProps {
  name: string;
  /** 18 / 22 / 26px. */
  size?: "sm" | "md" | "lg";
  color?: string;
}

const DIMS = { sm: 18, md: 22, lg: 26 } as const;

/** Circular initials avatar. Companion has no uploaded photos; initials are the identity. */
export function Avatar({ name, size = "md", color = colors.gray700 }: AvatarProps) {
  const dim = DIMS[size];
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <View style={[styles.avatar, { width: dim, height: dim, backgroundColor: color }]}>
      <Text style={[styles.initials, { fontSize: size === "sm" ? 9 : 10 }]}>{initials}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: { alignItems: "center", justifyContent: "center", borderRadius: radius.full, flexShrink: 0 },
  initials: { fontFamily: font.mono, fontWeight: font.weight.semibold, color: colors.gray0 },
});
