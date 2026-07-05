import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { noDragRegion, type PressState } from "./platform";
import { colors, control, font, radius, space } from "./tokens";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  disabled?: boolean;
}

/** Branded pressable control. Hover/press states use react-native-web's Pressable
 * state (no-op on native, which lacks hover). */
export function Button({ label, onPress, variant = "primary", size = "md", icon, disabled }: ButtonProps) {
  const v = variants[variant];
  const s = sizes[size];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      aria-label={label}
      style={({ hovered, pressed }: PressState) => [
        styles.base,
        noDragRegion,
        {
          height: s.height,
          paddingHorizontal: s.padH,
          borderRadius: s.radius,
          backgroundColor: pressed ? v.activeBg : hovered ? v.hoverBg : v.bg,
          borderWidth: 1,
          borderColor: v.border,
          opacity: disabled ? 0.45 : 1,
          // Always a valid transform array: on the New Architecture, clearing it back
          // to undefined is sent to native as null, and processTransform(null) crashes.
          transform: [{ scale: pressed ? 0.98 : 1 }],
        },
      ]}
    >
      {icon}
      <Text style={[styles.label, { fontSize: s.fontSize, color: v.fg }]}>{label}</Text>
    </Pressable>
  );
}

interface VariantStyle {
  bg: string;
  hoverBg: string;
  activeBg: string;
  fg: string;
  border: string;
}

const variants: Record<ButtonVariant, VariantStyle> = {
  primary: { bg: colors.accent, hoverBg: colors.accentHover, activeBg: colors.accentActive, fg: colors.onAccent, border: "transparent" },
  secondary: { bg: colors.surfaceCard, hoverBg: colors.surfaceHover, activeBg: colors.surfaceActive, fg: colors.textPrimary, border: colors.borderDefault },
  ghost: { bg: "transparent", hoverBg: colors.surfaceHover, activeBg: colors.surfaceActive, fg: colors.textSecondary, border: "transparent" },
  danger: { bg: colors.dangerSoft, hoverBg: "#f6dede", activeBg: "#efd0d0", fg: colors.danger, border: "transparent" },
};

const sizes: Record<ButtonSize, { height: number; padH: number; fontSize: number; radius: number }> = {
  sm: { height: control.sm, padH: space.lg, fontSize: font.size.sm, radius: radius.md },
  md: { height: control.md, padH: space.xl, fontSize: font.size.base, radius: radius.lg },
  lg: { height: control.lg, padH: space.xxl, fontSize: font.size.md, radius: radius.lg },
};

const styles = StyleSheet.create({
  base: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.md },
  label: { fontFamily: font.sans, fontWeight: font.weight.medium, letterSpacing: font.tracking.snug },
});
