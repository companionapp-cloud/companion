import { Row, Stack, Avatar, Text, colors } from "@companion/design-system";

/** A stack of collaborators on a shared project — medium avatars. */
export function Collaborators() {
  return (
    <Row gap={8} align="center" style={{ padding: 16, backgroundColor: colors.surfaceCard }}>
      <Avatar name="Chris Macrae" />
      <Avatar name="Dana Ortiz" />
      <Avatar name="Priya Nair" />
      <Avatar name="Sam Lee" />
    </Row>
  );
}

/** The two sizes side by side — compact list rows vs. headers. */
export function Sizes() {
  return (
    <Row gap={16} align="center" style={{ padding: 16, backgroundColor: colors.surfaceCard }}>
      <Row gap={6} align="center">
        <Avatar name="Chris Macrae" size="sm" />
        <Text variant="caption" tone="tertiary">sm</Text>
      </Row>
      <Row gap={6} align="center">
        <Avatar name="Chris Macrae" size="md" />
        <Text variant="caption" tone="tertiary">md</Text>
      </Row>
    </Row>
  );
}

/** An avatar paired with the note it last touched. */
export function AssignedRow() {
  return (
    <Row gap={10} align="center" style={{ padding: 16, backgroundColor: colors.surfaceCard }}>
      <Avatar name="Dana Ortiz" />
      <Stack gap={2}>
        <Text variant="label">Q3 planning</Text>
        <Text variant="caption" tone="tertiary">Edited by Dana · 2 hours ago</Text>
      </Stack>
    </Row>
  );
}
