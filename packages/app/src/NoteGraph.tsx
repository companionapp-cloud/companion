import { Center, Icon, Text, colors } from "@companion/design-system";

// React Flow is DOM-only, so the per-note graph is web/desktop only for now, matching
// GraphScreen (PLAN §5.3). Native shows a placeholder until the mobile webview canvas
// lands. The prop shape mirrors NoteGraph.web so callers are platform-agnostic.
export function NoteGraph(_props: { noteId: string; depth?: number }) {
  return (
    <Center>
      <Icon name="graph" size={18} color={colors.textQuaternary} />
      <Text variant="caption" tone="tertiary" style={{ textAlign: "center", maxWidth: 300 }}>
        The note graph is available on web and desktop.
      </Text>
    </Center>
  );
}
