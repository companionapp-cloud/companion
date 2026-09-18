import { Platform, StyleSheet, TextInput } from "react-native";
import { useDensity } from "./Density";
import { colors, font } from "./tokens";

export type FieldVariant = "title" | "prose" | "code";

export interface TextFieldProps {
  value?: string;
  onChangeText?: (text: string) => void;
  placeholder?: string;
  multiline?: boolean;
  autoFocus?: boolean;
  variant?: FieldVariant;
}

/** Borderless, document-style editable field. "title" is the 30px display heading (20px on
 * touch surfaces, where 30px clips at phone width), "prose" the 14px/22px reading body,
 * "code" 13px mono. No border, no background, no focus ring — the caret is the only
 * affordance. */
export function TextField({
  value,
  onChangeText,
  placeholder,
  multiline,
  autoFocus,
  variant = "prose",
}: TextFieldProps) {
  const density = useDensity();
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.textQuaternary}
      multiline={multiline}
      autoFocus={autoFocus}
      style={[styles.base, styles[variant], variant === "title" && density === "touch" ? styles.titleTouch : null]}
    />
  );
}

const styles = StyleSheet.create({
  base: {
    padding: 0,
    color: colors.textPrimary,
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as Record<string, unknown>) : null),
  },
  title: {
    fontFamily: font.sans,
    fontSize: font.size.display,
    fontWeight: font.weight.semibold,
    letterSpacing: font.tracking.tight,
  },
  titleTouch: { fontSize: font.size["2xl"], letterSpacing: font.tracking.snug },
  prose: {
    fontFamily: font.sans,
    fontSize: font.size.md,
    lineHeight: 22,
    flex: 1,
    textAlignVertical: "top",
  },
  code: {
    fontFamily: font.mono,
    fontSize: font.size.base,
    lineHeight: 20,
    flex: 1,
    textAlignVertical: "top",
  },
});
