import type { ReactNode } from "react";
import { Text as RNText, StyleSheet, type StyleProp, type TextStyle } from "react-native";
import { colors, font } from "./tokens";

export type TextVariant =
  | "display" // large note/document title
  | "heading" // section heading
  | "title" // panel/toolbar title
  | "body"
  | "label" // list-row title weight
  | "caption"
  | "mono" // ids, metadata, timestamps — everything the machine owns
  | "eyebrow"; // uppercase mono section label (REPEATING · 3)

export type TextTone = "default" | "secondary" | "tertiary" | "quaternary" | "accent" | "danger" | "success" | "info" | "inverse";

export interface TextProps {
  variant?: TextVariant;
  tone?: TextTone;
  numberOfLines?: number;
  style?: StyleProp<TextStyle>;
  children?: ReactNode;
}

/** Typographic primitive. All text goes through this. */
export function Text({ variant = "body", tone = "default", numberOfLines, style, children }: TextProps) {
  return (
    <RNText numberOfLines={numberOfLines} style={[variantStyles[variant], { color: toneColors[tone] }, style]}>
      {children}
    </RNText>
  );
}

const toneColors: Record<TextTone, string> = {
  default: colors.textPrimary,
  secondary: colors.textSecondary,
  tertiary: colors.textTertiary,
  quaternary: colors.textQuaternary,
  accent: colors.textAccent,
  danger: colors.danger,
  success: colors.success,
  info: colors.info,
  inverse: colors.textInverse,
};

const lh = (size: number, leading: number) => Math.round(size * leading);

const variantStyles = StyleSheet.create({
  display: {
    fontFamily: font.sans,
    fontSize: font.size.display,
    fontWeight: font.weight.semibold,
    letterSpacing: font.tracking.tight,
    lineHeight: lh(font.size.display, font.leading.tight),
  },
  heading: {
    fontFamily: font.sans,
    fontSize: font.size.xl,
    fontWeight: font.weight.semibold,
    letterSpacing: font.tracking.snug,
    lineHeight: lh(font.size.xl, font.leading.tight),
  },
  title: {
    fontFamily: font.sans,
    fontSize: font.size.lg,
    fontWeight: font.weight.semibold,
    letterSpacing: font.tracking.snug,
    lineHeight: lh(font.size.lg, font.leading.ui),
  },
  body: { fontFamily: font.sans, fontSize: font.size.base, lineHeight: lh(font.size.base, font.leading.ui) },
  label: {
    fontFamily: font.sans,
    fontSize: font.size.base,
    fontWeight: font.weight.medium,
    lineHeight: lh(font.size.base, font.leading.ui),
  },
  caption: { fontFamily: font.sans, fontSize: font.size.sm, lineHeight: lh(font.size.sm, font.leading.ui) },
  mono: { fontFamily: font.mono, fontSize: font.size.xs, lineHeight: lh(font.size.xs, font.leading.ui) },
  eyebrow: {
    fontFamily: font.mono,
    fontSize: font.size["2xs"],
    fontWeight: font.weight.semibold,
    letterSpacing: font.tracking.eyebrow,
    textTransform: "uppercase",
  },
});
