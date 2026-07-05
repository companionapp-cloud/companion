import { useState, type ReactNode } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { colors, control, font, radius, space } from "./tokens";

export interface InputProps {
  value?: string;
  onChangeText?: (text: string) => void;
  placeholder?: string;
  leadingIcon?: ReactNode;
  size?: "sm" | "md";
  secureTextEntry?: boolean;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  autoFocus?: boolean;
  /** Fired when the field loses focus (in addition to clearing the focus ring). */
  onBlur?: () => void;
  /** Fired when the user presses Enter/Return. */
  onSubmitEditing?: () => void;
}

/** Bordered single-line text input with an optional leading icon and focus ring. */
export function Input({ value, onChangeText, placeholder, leadingIcon, size = "md", secureTextEntry, autoCapitalize, autoFocus, onBlur, onSubmitEditing }: InputProps) {
  const [focused, setFocused] = useState(false);
  const height = size === "sm" ? control.sm : control.md;
  const fontSize = size === "sm" ? font.size.sm : font.size.base;
  return (
    <View
      style={[
        styles.wrap,
        { height, borderColor: focused ? colors.borderFocus : colors.borderDefault },
      ]}
    >
      {leadingIcon}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textTertiary}
        secureTextEntry={secureTextEntry}
        autoCapitalize={autoCapitalize}
        autoFocus={autoFocus}
        onSubmitEditing={onSubmitEditing}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          onBlur?.();
        }}
        style={[styles.input, { fontSize }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    backgroundColor: colors.surfaceCard,
    borderWidth: 1,
    borderRadius: radius.lg,
  },
  input: {
    flex: 1,
    fontFamily: font.sans,
    color: colors.textPrimary,
  },
});
