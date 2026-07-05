import { View } from "react-native";
import { Text, space } from "@companion/design-system";

// React Flow is DOM-only, so the per-note graph is web/desktop only for now, matching
// GraphScreen (PLAN §5.3). Native shows a placeholder until the mobile webview canvas
// lands. The prop shape mirrors NoteGraph.web so callers are platform-agnostic.
export function NoteGraph(_props: { noteId: string; depth?: number }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.xxxl }}>
      <Text tone="tertiary" style={{ textAlign: "center", maxWidth: 320, lineHeight: 22 }}>
        The note graph is available on web and desktop.
      </Text>
    </View>
  );
}
