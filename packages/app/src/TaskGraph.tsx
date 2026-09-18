import { Center, Icon, Text, colors } from "@companion/design-system";

// React Flow is DOM-only, so the per-task graph is web/desktop only for now (mobile uses
// the webview canvas via a screen). The prop shape mirrors TaskGraph.web so callers are
// platform-agnostic.
export function TaskGraph(_props: { taskId: string; depth?: number }) {
  return (
    <Center>
      <Icon name="graph" size={18} color={colors.textQuaternary} />
      <Text variant="caption" tone="tertiary" style={{ textAlign: "center", maxWidth: 300 }}>
        The task graph is available on web and desktop.
      </Text>
    </Center>
  );
}
