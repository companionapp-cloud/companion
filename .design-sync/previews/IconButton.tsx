import { Row, Stack, IconButton, Icon, Text, colors } from "@companion/design-system";

/** An editor toolbar of quiet icon-only buttons. */
export function Toolbar() {
  return (
    <Row gap={2} align="center" style={{ padding: 16, backgroundColor: colors.surfaceCard }}>
      <IconButton label="Bold"><Icon name="bold" size={18} color={colors.textSecondary} /></IconButton>
      <IconButton label="Italic"><Icon name="italic" size={18} color={colors.textSecondary} /></IconButton>
      <IconButton label="Bulleted list"><Icon name="listBullet" size={18} color={colors.textSecondary} /></IconButton>
      <IconButton label="Quote"><Icon name="quote" size={18} color={colors.textSecondary} /></IconButton>
      <IconButton label="Code block"><Icon name="codeBlock" size={18} color={colors.textSecondary} /></IconButton>
    </Row>
  );
}

/** Active state highlights the selected control. */
export function Active() {
  return (
    <Row gap={2} align="center" style={{ padding: 16, backgroundColor: colors.surfaceCard }}>
      <IconButton label="Bold" active><Icon name="bold" size={18} color={colors.accent} /></IconButton>
      <IconButton label="Italic"><Icon name="italic" size={18} color={colors.textSecondary} /></IconButton>
      <IconButton label="Strikethrough"><Icon name="strikethrough" size={18} color={colors.textSecondary} /></IconButton>
    </Row>
  );
}

/** The two sizes. */
export function Sizes() {
  return (
    <Row gap={12} align="center" style={{ padding: 16, backgroundColor: colors.surfaceCard }}>
      <Stack gap={4} align="center">
        <IconButton label="Search" size="sm"><Icon name="search" size={16} color={colors.textSecondary} /></IconButton>
        <Text variant="caption" tone="tertiary">sm</Text>
      </Stack>
      <Stack gap={4} align="center">
        <IconButton label="Search" size="md"><Icon name="search" size={18} color={colors.textSecondary} /></IconButton>
        <Text variant="caption" tone="tertiary">md</Text>
      </Stack>
    </Row>
  );
}

/** Disabled next to enabled. */
export function Disabled() {
  return (
    <Row gap={2} align="center" style={{ padding: 16, backgroundColor: colors.surfaceCard }}>
      <IconButton label="New note"><Icon name="plus" size={18} color={colors.textSecondary} /></IconButton>
      <IconButton label="Delete" disabled><Icon name="trash" size={18} color={colors.textSecondary} /></IconButton>
    </Row>
  );
}
