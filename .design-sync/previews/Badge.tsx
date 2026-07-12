import { Row, Stack, Badge, Text, colors } from "@companion/design-system";

/** The two tones — neutral metadata vs. accent emphasis. */
export function Tones() {
  return (
    <Row gap={10} align="center" style={{ padding: 16, backgroundColor: colors.surfaceCard }}>
      <Badge label="2 links" />
      <Badge label="New" tone="accent" />
    </Row>
  );
}

/** Counts as they appear on notes and projects. */
export function Counts() {
  return (
    <Row gap={10} align="center" style={{ padding: 16, backgroundColor: colors.surfaceCard }}>
      <Badge label="12" />
      <Badge label="3 tasks" />
      <Badge label="8 notes" />
      <Badge label="1 backlink" />
    </Row>
  );
}

/** A badge trailing a note title, calling out unsaved work. */
export function OnTitle() {
  return (
    <Row gap={8} align="center" style={{ padding: 16, backgroundColor: colors.surfaceCard }}>
      <Text variant="label">Migrating the sync engine</Text>
      <Badge label="Draft" tone="accent" />
    </Row>
  );
}
