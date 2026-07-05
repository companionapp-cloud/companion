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
  | "mono"; // ids, metadata, timestamps

export type TextTone = "default" | "secondary" | "tertiary" | "accent" | "danger" | "inverse";

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
  accent: colors.textAccent,
  danger: colors.danger,
  inverse: colors.textInverse,
};

const variantStyles = StyleSheet.create({
  display: {
    fontFamily: font.sans,
    fontSize: font.size["3xl"],
    fontWeight: font.weight.semibold,
    letterSpacing: font.tracking.tight,
    lineHeight: 36,
  },
  heading: {
    fontFamily: font.sans,
    fontSize: font.size.lg,
    fontWeight: font.weight.semibold,
    letterSpacing: font.tracking.snug,
  },
  title: {
    fontFamily: font.sans,
    fontSize: font.size.md,
    fontWeight: font.weight.semibold,
    letterSpacing: font.tracking.snug,
  },
  body: { fontFamily: font.sans, fontSize: font.size.base },
  label: { fontFamily: font.sans, fontSize: font.size.base, fontWeight: font.weight.medium },
  caption: { fontFamily: font.sans, fontSize: font.size.sm },
  mono: { fontFamily: font.mono, fontSize: font.size.xs },
});
