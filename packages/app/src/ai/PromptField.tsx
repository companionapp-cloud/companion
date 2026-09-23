import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Platform, StyleSheet, TextInput, View } from "react-native";
import { colors, control, font, motion, radius, space, transition, useDensity } from "@companion/design-system";

// The AI panel's prompt: a textarea that sits on one line like the app's inputs and grows with
// what's typed, up to MAX_LINES, then scrolls. Enter submits; Shift-Enter starts a new line.

const MAX_LINES = 6;

export function PromptField({
  value,
  onChangeText,
  onSubmit,
  placeholder,
  autoFocus,
  leading,
  trailing,
}: {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const touch = useDensity() === "touch";
  // 16px on touch keeps iOS Safari from zooming into the focused field (as Input does).
  const fontSize = touch ? 16 : font.size.base;
  const lineHeight = Math.round(fontSize * font.leading.ui);
  // One line's field height matches Input's, so the collapsed prompt reads as an ordinary input.
  const oneLine = touch ? control.lg : control.md;
  const padV = Math.max(0, (oneLine - 2 - lineHeight) / 2);
  const maxHeight = lineHeight * MAX_LINES;
  const [height, setHeight] = useState(lineHeight);
  const [focused, setFocused] = useState(false);
  const ref = useRef<unknown>(null);

  // Web: react-native-web's textarea doesn't report its content size, so measure it — collapse
  // it, read scrollHeight, restore — whenever the text changes. Native uses onContentSizeChange.
  useLayoutEffect(() => {
    if (Platform.OS !== "web") return;
    const el = ref.current as HTMLTextAreaElement | null;
    if (!el || typeof el.scrollHeight !== "number") return;
    const prev = el.style.height;
    el.style.height = "0px";
    const next = el.scrollHeight;
    el.style.height = prev;
    setHeight(Math.min(maxHeight, Math.max(lineHeight, next)));
  }, [value, lineHeight, maxHeight]);

  return (
    <View
      style={[
        styles.wrap,
        transition("border-color, box-shadow", motion.fast),
        { paddingVertical: padV, borderColor: focused ? colors.borderFocus : colors.borderDefault },
        focused ? focusRing : null,
      ]}
    >
      {leading ? <View style={[styles.slot, styles.top, { height: lineHeight }]}>{leading}</View> : null}
      <TextInput
        ref={ref}
        multiline
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textQuaternary}
        autoFocus={autoFocus}
        // Native: Return submits (no newline); the web handles Enter vs Shift-Enter below.
        submitBehavior={Platform.OS === "web" ? undefined : "submit"}
        onSubmitEditing={Platform.OS === "web" ? undefined : onSubmit}
        onKeyPress={(e) => {
          if (Platform.OS !== "web") return;
          const { key, shiftKey, isComposing } = e.nativeEvent;
          if (key === "Enter" && !shiftKey && !isComposing) {
            e.preventDefault?.();
            onSubmit();
          }
        }}
        onContentSizeChange={(e) => {
          if (Platform.OS === "web") return;
          setHeight(Math.min(maxHeight, Math.max(lineHeight, e.nativeEvent.contentSize.height)));
        }}
        scrollEnabled={height >= maxHeight}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[styles.input, { fontSize, lineHeight, height }]}
      />
      {trailing ? <View style={[styles.slot, styles.bottom, { height: lineHeight }]}>{trailing}</View> : null}
    </View>
  );
}

const focusRing = Platform.OS === "web" ? ({ boxShadow: `0 0 0 2px ${colors.focusRing}` } as Record<string, unknown>) : null;

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    gap: space.sm,
    paddingHorizontal: space.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceCard,
    minWidth: 0,
  },
  // As the field grows the leading icon stays by the first line and the submit key by the last.
  slot: { justifyContent: "center" },
  top: { alignSelf: "flex-start" },
  bottom: { alignSelf: "flex-end" },
  input: {
    flex: 1,
    minWidth: 0,
    padding: 0,
    paddingTop: 0,
    fontFamily: font.sans,
    color: colors.textPrimary,
    textAlignVertical: "top",
    ...(Platform.OS === "web" ? ({ outlineStyle: "none", resize: "none" } as Record<string, unknown>) : null),
  },
});
