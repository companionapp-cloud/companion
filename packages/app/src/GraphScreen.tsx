import { Center, Icon, Text, colors } from "@companion/design-system";

// React Flow is DOM-only, so the graph canvas is web/desktop only for now (PLAN §5.3).
// The mobile canvas will follow the editor's pattern — a DOM component in a webview —
// in a later milestone. Until then, native shows a placeholder.
export function GraphScreen() {
  return (
    <Center style={{ backgroundColor: colors.surfaceCard }}>
      <Icon name="graph" size={18} color={colors.textQuaternary} />
      <Text variant="caption" tone="tertiary" style={{ textAlign: "center", maxWidth: 300, lineHeight: 18 }}>
        The graph view is available on web and desktop. A mobile canvas is on the way.
      </Text>
    </Center>
  );
}
