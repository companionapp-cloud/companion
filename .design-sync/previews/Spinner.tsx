import { Stack, Row, Spinner, Text, colors } from "@companion/design-system";

/** A bare spinner, as it shows mid-panel while a note list loads. */
export function Bare() {
  return (
    <Stack style={{ padding: 16, height: 96, backgroundColor: colors.surfaceCard }}>
      <Spinner />
    </Stack>
  );
}

/** With a label, syncing state in the status area. */
export function Labeled() {
  return (
    <Stack style={{ padding: 16, height: 120, backgroundColor: colors.surfaceCard }}>
      <Spinner label="Syncing notes…" />
    </Stack>
  );
}

/** Inline beside a heading while a project's tasks load. */
export function Inline() {
  return (
    <Row gap={12} align="center" style={{ padding: 16, height: 72, backgroundColor: colors.surfaceCard }}>
      <Stack style={{ width: 40, height: 40 }}>
        <Spinner />
      </Stack>
      <Text variant="label" tone="secondary">Loading Q3 planning…</Text>
    </Row>
  );
}
