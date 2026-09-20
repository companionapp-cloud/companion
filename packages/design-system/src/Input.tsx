import { useState, type ReactNode } from "react";
import { Platform, StyleSheet, TextInput, View } from "react-native";
import { useDensity } from "./Density";
import { transition } from "./platform";
import { colors, control, font, motion, radius, space } from "./tokens";

export interface InputProps {
  value?: string;
  onChangeText?: (text: string) => void;
  placeholder?: string;
  leadingIcon?: ReactNode;
  /** Trailing slot — a `Kbd` shortcut hint, a count, a clear button. */
  trailing?: ReactNode;
  /** 22 / 26 / 30px. Defaults to `md` with a pointer, `lg` on touch surfaces. */
  size?: "sm" | "md" | "lg";
  /** Render the value in Geist Mono — for ids, URLs, paths, keys. */
  mono?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  secureTextEntry?: boolean;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  autoFocus?: boolean;
  /** Fired when the field loses focus (in addition to clearing the focus ring). */
  onBlur?: () => void;
  /** Fired when the user presses Enter/Return. */
  onSubmitEditing?: () => void;
  /** Keep focus after Enter — a quick-add field that takes one entry after another. */
  keepFocusOnSubmit?: boolean;
}

/** Bordered single-line field with an optional leading icon, trailing slot and focus
 * ring. The workhorse of every filter, search and quick-add row. */
export function Input({
  value,
  onChangeText,
  placeholder,
  leadingIcon,
  trailing,
  size,
  mono,
  invalid,
  disabled,
  secureTextEntry,
  autoCapitalize,
  autoFocus,
  onBlur,
  onSubmitEditing,
  keepFocusOnSubmit,
}: InputProps) {
  const [focused, setFocused] = useState(false);
  const density = useDensity();
  const resolved = size ?? (density === "touch" ? "lg" : "md");
  const height = control[resolved];
  // 16px on touch keeps iOS Safari from zooming the page into a focused field.
  const fontSize = density === "touch" ? 16 : resolved === "sm" ? font.size.sm : font.size.base;
  return (
    <View
      style={[
        styles.wrap,
        transition("border-color, box-shadow", motion.fast),
        {
          height,
          backgroundColor: disabled ? colors.surfaceSunken : colors.surfaceCard,
          borderColor: invalid ? colors.danger : focused ? colors.borderFocus : colors.borderDefault,
        },
        focused && !invalid ? focusRing : null,
      ]}
    >
      {leadingIcon}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textQuaternary}
        secureTextEntry={secureTextEntry}
        autoCapitalize={autoCapitalize}
        autoFocus={autoFocus}
        editable={!disabled}
        onSubmitEditing={onSubmitEditing}
        blurOnSubmit={keepFocusOnSubmit ? false : undefined}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          onBlur?.();
        }}
        style={[styles.input, { fontSize, fontFamily: mono ? font.mono : font.sans }]}
      />
      {trailing}
    </View>
  );
}

// The 2px focus halo. box-shadow spread is a web affordance; native shows the border only.
const focusRing = Platform.OS === "web" ? ({ boxShadow: `0 0 0 2px ${colors.focusRing}` } as Record<string, unknown>) : null;

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    minWidth: 0,
  },
  input: {
    flex: 1,
    minWidth: 0,
    padding: 0,
    color: colors.textPrimary,
    // react-native-web draws the browser focus outline otherwise; the wrapper owns focus.
    ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as Record<string, unknown>) : null),
  },
});
