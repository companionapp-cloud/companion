import { Divider, Stack, Row, Text, Badge, colors, radius } from "@companion/design-system";

/** Divider separates titled sections within a card. */
export function BetweenSections() {
  return (
    <Stack
      gap={12}
      style={{
        width: 320,
        margin: 16,
        padding: 16,
        backgroundColor: colors.surfaceCard,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.borderSubtle,
      }}
    >
      <Stack gap={2}>
        <Text variant="title">Weekly review</Text>
        <Text variant="caption" tone="tertiary">Due Friday</Text>
      </Stack>
      <Divider />
      <Stack gap={2}>
        <Text variant="title">Q3 planning</Text>
        <Text variant="caption" tone="tertiary">Draft · 3 open tasks</Text>
      </Stack>
      <Divider />
      <Stack gap={2}>
        <Text variant="title">Reading list</Text>
        <Text variant="caption" tone="tertiary">12 saved articles</Text>
      </Stack>
    </Stack>
  );
}

/** A divider between a metadata header and its body content. */
export function HeaderRule() {
  return (
    <Stack
      gap={12}
      style={{
        width: 320,
        margin: 16,
        padding: 16,
        backgroundColor: colors.surfaceCard,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.borderSubtle,
      }}
    >
      <Row justify="between" align="center">
        <Text variant="heading">Migrating sync</Text>
        <Badge label="draft" tone="accent" />
      </Row>
      <Divider />
      <Text variant="body">
        The sync layer now resolves conflicts field-by-field, so two people editing the
        same note no longer clobber each other's work.
      </Text>
    </Stack>
  );
}
