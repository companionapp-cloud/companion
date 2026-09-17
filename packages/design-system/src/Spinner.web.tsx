import { StyleSheet, View } from "react-native";
import { Text } from "./Text";
import { colors, space } from "./tokens";
import type { SpinnerProps } from "./Spinner.types";

// The system's only looping animation: a 700ms linear hairline ring.
const KEYFRAMES_ID = "companion-spin";
if (typeof document !== "undefined" && !document.getElementById(KEYFRAMES_ID)) {
  const el = document.createElement("style");
  el.id = KEYFRAMES_ID;
  el.textContent = "@keyframes companion-spin{to{transform:rotate(360deg)}}";
  document.head.appendChild(el);
}

/** Indeterminate loader for list loads and sync; never blocks a whole screen. */
export function Spinner({ label, size = 14, inline = false }: SpinnerProps) {
  return (
    <View style={inline ? styles.inline : styles.block}>
      <span
        role="progressbar"
        aria-label={label ?? "Loading"}
        style={{
          width: size,
          height: size,
          flexShrink: 0,
          boxSizing: "border-box",
          borderRadius: "50%",
          border: `1.5px solid ${colors.borderSubtle}`,
          borderTopColor: colors.accent,
          animation: "companion-spin 700ms linear infinite",
        }}
      />
      {label ? (
        <Text tone="tertiary" variant="mono">
          {label}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.md, padding: space.xxl },
  inline: { flexDirection: "row", alignItems: "center", gap: space.md },
});
