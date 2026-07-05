import { View } from "react-native";
import { Text, space } from "@companion/design-system";

// React Flow is DOM-only, so the graph canvas is web/desktop only for now (PLAN §5.3).
// The mobile canvas will follow the editor's pattern — a DOM component in a webview —
// in a later milestone. Until then, native shows a placeholder.
export function GraphScreen() {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.xxxl }}>
      <Text tone="tertiary" style={{ textAlign: "center", maxWidth: 360, lineHeight: 22 }}>
        The graph view is available on web and desktop. A mobile canvas is on the way.
      </Text>
    </View>
  );
}
