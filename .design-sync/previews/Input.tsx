import { Stack, Row, Input, Icon, Text, colors } from "@companion/design-system";

/** Empty (placeholder) next to a filled value. */
export function States() {
  return (
    <Stack gap={12} style={{ padding: 16, width: 320 }}>
      <Input placeholder="Search notes and tasks…" />
      <Input value="Weekly review — Q3 planning" />
    </Stack>
  );
}

/** A leading icon composed into the field. */
export function WithLeadingIcon() {
  return (
    <Stack gap={12} style={{ padding: 16, width: 320 }}>
      <Input
        placeholder="Search…"
        leadingIcon={<Icon name="search" size={16} color={colors.textTertiary} />}
      />
      <Input
        value="Reading list"
        leadingIcon={<Icon name="folder" size={16} color={colors.textTertiary} />}
      />
    </Stack>
  );
}

/** The two control sizes. */
export function Sizes() {
  return (
    <Stack gap={12} style={{ padding: 16, width: 320 }}>
      <Row gap={8} align="center">
        <Text variant="caption" tone="tertiary" style={{ width: 48 }}>sm</Text>
        <Input size="sm" value="Add a tag" />
      </Row>
      <Row gap={8} align="center">
        <Text variant="caption" tone="tertiary" style={{ width: 48 }}>md</Text>
        <Input size="md" value="Add a tag" />
      </Row>
    </Stack>
  );
}
