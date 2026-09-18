import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { useDensity } from "./Density";
import { noDragRegion, transition, type PressState } from "./platform";
import { colors, control, font, motion, radius, space } from "./tokens";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  /** Defaults to `md` (26px) with a pointer, `lg` (30px) on touch surfaces. */
  size?: ButtonSize;
  icon?: ReactNode;
  /** Mono shortcut hint after the label (e.g. "⌘⏎"). Shortcuts are documented in the UI. */
  kbd?: string;
  disabled?: boolean;
  fullWidth?: boolean;
}

/** The system's text action. Hover darkens, press darkens further — nothing scales, lifts
 * or translates. Hover comes from react-native-web's Pressable state (absent on native). */
export function Button({ label, onPress, variant = "primary", size, icon, kbd, disabled, fullWidth }: ButtonProps) {
  const density = useDensity();
  const v = variants[variant];
  const s = sizes[size ?? (density === "touch" ? "lg" : "md")];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      aria-label={label}
      style={({ hovered, pressed }: PressState) => [
        styles.base,
        noDragRegion,
        transition("background-color, border-color", motion.fast),
        {
          height: s.height,
          paddingHorizontal: s.padH,
          borderRadius: s.radius,
          backgroundColor: disabled ? v.bg : pressed ? v.activeBg : hovered ? v.hoverBg : v.bg,
          borderColor: v.border,
          opacity: disabled ? 0.4 : 1,
        },
        fullWidth ? styles.fullWidth : null,
      ]}
    >
      {icon}
      <Text numberOfLines={1} style={[styles.label, { fontSize: s.fontSize, color: v.fg }]}>
        {label}
      </Text>
      {kbd ? <Text style={[styles.kbd, { color: v.fg }]}>{kbd}</Text> : null}
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
  danger: { bg: colors.dangerSoft, hoverBg: colors.dangerSoftHover, activeBg: colors.dangerSoftActive, fg: colors.danger, border: "transparent" },
};

const sizes: Record<ButtonSize, { height: number; padH: number; fontSize: number; radius: number }> = {
  sm: { height: control.sm, padH: space.md, fontSize: font.size.sm, radius: radius.sm },
  md: { height: control.md, padH: space.ml, fontSize: font.size.base, radius: radius.md },
  lg: { height: control.lg, padH: 14, fontSize: font.size.md, radius: radius.md },
};

const styles = StyleSheet.create({
  base: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, borderWidth: 1 },
  fullWidth: { alignSelf: "stretch" },
  label: { fontFamily: font.sans, fontWeight: font.weight.medium, letterSpacing: font.tracking.snug },
  kbd: { fontFamily: font.mono, fontSize: font.size.xs, opacity: 0.6, marginLeft: space.xxs },
});
