import { Row, Stack, ProgressRing, Text, colors } from "@companion/design-system";

/** Task completion across projects — empty to done. */
export function Values() {
  return (
    <Row gap={20} align="center" style={{ padding: 16, backgroundColor: colors.surfaceCard }}>
      <Stack gap={6} align="center">
        <ProgressRing value={0.25} size={22} />
        <Text variant="caption" tone="tertiary">25%</Text>
      </Stack>
      <Stack gap={6} align="center">
        <ProgressRing value={0.6} size={22} />
        <Text variant="caption" tone="tertiary">60%</Text>
      </Stack>
      <Stack gap={6} align="center">
        <ProgressRing value={0.9} size={22} />
        <Text variant="caption" tone="tertiary">90%</Text>
      </Stack>
      <Stack gap={6} align="center">
        <ProgressRing value={1} size={22} />
        <Text variant="caption" tone="tertiary">Done</Text>
      </Stack>
    </Row>
  );
}

/** The completion ring beside its project, as it reads in the sidebar. */
export function InProject() {
  return (
    <Stack gap={10} style={{ padding: 16, width: 260, backgroundColor: colors.surfaceCard }}>
      <Row gap={10} align="center">
        <ProgressRing value={0.4} size={16} />
        <Text variant="label">Q3 planning</Text>
      </Row>
      <Row gap={10} align="center">
        <ProgressRing value={1} size={16} />
        <Text variant="label">Weekly review</Text>
      </Row>
    </Stack>
  );
}

/** A larger ring for a dashboard summary tile. */
export function Large() {
  return (
    <Row gap={12} align="center" style={{ padding: 16, backgroundColor: colors.surfaceCard }}>
      <ProgressRing value={0.72} size={48} stroke={5} />
      <Stack gap={2}>
        <Text variant="title">18 of 25 tasks</Text>
        <Text variant="caption" tone="tertiary">This week</Text>
      </Stack>
    </Row>
  );
}
