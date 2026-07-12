import { Row, Stack, Text, Button, Badge, Icon, Avatar, colors, radius } from "@companion/design-system";

const panel = {
  width: 360,
  margin: 16,
  padding: 12,
  backgroundColor: colors.surfaceCard,
  borderRadius: radius.lg,
  borderWidth: 1,
  borderColor: colors.borderSubtle,
} as const;

/** A row of action buttons, left-aligned with a consistent gap. */
export function ActionBar() {
  return (
    <Row gap={8} align="center" style={panel}>
      <Button label="Save" variant="primary" size="sm" />
      <Button label="Duplicate" variant="secondary" size="sm" />
      <Button label="Archive" variant="ghost" size="sm" />
    </Row>
  );
}

/** justify="between" pushes a title and its metadata to opposite edges. */
export function TitleAndMeta() {
  return (
    <Row gap={8} justify="between" align="center" style={panel}>
      <Row gap={8} align="center">
        <Icon name="folder" size={18} color={colors.accent} />
        <Text variant="title">Design system</Text>
      </Row>
      <Badge label="8 notes" />
    </Row>
  );
}

/** A metadata row of tag badges. */
export function TagRow() {
  return (
    <Row gap={6} align="center" style={panel}>
      <Text variant="caption" tone="tertiary">Tags</Text>
      <Badge label="research" />
      <Badge label="sync" />
      <Badge label="urgent" tone="accent" />
    </Row>
  );
}

/** An avatar stack beside collaborator text — vertically centered. */
export function Collaborators() {
  return (
    <Row gap={10} align="center" style={panel}>
      <Row gap={4}>
        <Avatar name="Chris Macrae" size="sm" />
        <Avatar name="Dana Lee" size="sm" />
        <Avatar name="Sam Ito" size="sm" />
      </Row>
      <Stack gap={0}>
        <Text variant="label">3 collaborators</Text>
        <Text variant="caption" tone="tertiary">editing now</Text>
      </Stack>
    </Row>
  );
}
