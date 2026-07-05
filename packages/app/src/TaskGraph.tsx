import { View } from "react-native";
import { Text, space } from "@companion/design-system";

// React Flow is DOM-only, so the per-task graph is web/desktop only for now (mobile uses
// the webview canvas via a screen). The prop shape mirrors TaskGraph.web so callers are
// platform-agnostic.
export function TaskGraph(_props: { taskId: string; depth?: number }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.xxxl }}>
      <Text tone="tertiary" style={{ textAlign: "center", maxWidth: 320, lineHeight: 22 }}>
        The task graph is available on web and desktop.
      </Text>
    </View>
  );
}
