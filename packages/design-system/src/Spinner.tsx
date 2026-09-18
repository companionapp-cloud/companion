import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Text } from "./Text";
import { colors, space } from "./tokens";
import type { SpinnerProps } from "./Spinner.types";


/** Indeterminate loader for list loads and sync; never blocks a whole screen. Native
 * variant — web/desktop resolve Spinner.web.tsx (the 700ms hairline ring). */
export function Spinner({ label, inline = false }: SpinnerProps) {
  return (
    <View style={inline ? styles.inline : styles.block}>
      <ActivityIndicator size="small" color={colors.accent} />
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
