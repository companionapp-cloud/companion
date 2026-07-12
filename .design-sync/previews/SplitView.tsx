import {
  SplitView,
  Stack,
  Row,
  ListRow,
  Text,
  Badge,
  Icon,
  colors,
} from "@companion/design-system";

/** A list pane beside a content pane — the app's core reading layout. */
export function ListAndContent() {
  return (
    <Stack style={{ height: 340, width: 560, margin: 16, borderWidth: 1, borderColor: colors.borderSubtle }}>
      <SplitView
        defaultWidth={220}
        aside={
          <Stack gap={2} style={{ padding: 8, height: "100%", backgroundColor: colors.surfaceApp }}>
            <ListRow title="Sprint retro" icon={<Icon name="notes" size={18} />} subtitle="June 14" selected />
            <ListRow title="Q3 planning" icon={<Icon name="notes" size={18} />} subtitle="Draft" />
            <ListRow title="Sync design" icon={<Icon name="notes" size={18} />} subtitle="edited 2h ago" />
            <ListRow title="Reading list" icon={<Icon name="file" size={18} />} trailing="12" />
          </Stack>
        }
      >
        <Stack gap={8} style={{ padding: 20, height: "100%", backgroundColor: colors.surfaceCard }}>
          <Text variant="heading">Sprint retro</Text>
          <Text variant="caption" tone="tertiary">June 14 · 4 min read</Text>
          <Text variant="body">
            We shipped the field-level sync engine and cut conflict resolution errors to
            near zero. Two people editing the same note no longer clobber each other's work.
          </Text>
        </Stack>
      </SplitView>
    </Stack>
  );
}

/** The aside can sit on the right — e.g. a details inspector. */
export function RightInspector() {
  return (
    <Stack style={{ height: 340, width: 560, margin: 16, borderWidth: 1, borderColor: colors.borderSubtle }}>
      <SplitView
        asideSide="right"
        defaultWidth={220}
        aside={
          <Stack gap={12} style={{ padding: 16, height: "100%", backgroundColor: colors.surfaceApp }}>
            <Text variant="title">Details</Text>
            <Stack gap={2}>
              <Text variant="caption" tone="tertiary">Project</Text>
              <Text variant="label">Design system</Text>
            </Stack>
            <Stack gap={2}>
              <Text variant="caption" tone="tertiary">Status</Text>
              <Row><Badge label="in review" tone="accent" /></Row>
            </Stack>
            <Stack gap={2}>
              <Text variant="caption" tone="tertiary">Links</Text>
              <Text variant="label">3 backlinks</Text>
            </Stack>
          </Stack>
        }
      >
        <Stack gap={8} style={{ padding: 20, height: "100%", backgroundColor: colors.surfaceCard }}>
          <Text variant="heading">Migrating sync</Text>
          <Text variant="body">
            The content pane flexes to fill the space left of the inspector. Drag the
            divider to resize the panel on desktop.
          </Text>
        </Stack>
      </SplitView>
    </Stack>
  );
}
