import { Stack, Row, Text, Badge, Icon, colors, radius } from "@companion/design-system";

const panel = {
  width: 340,
  margin: 16,
  padding: 16,
  backgroundColor: colors.surfaceCard,
  borderRadius: radius.lg,
  borderWidth: 1,
  borderColor: colors.borderSubtle,
} as const;

/** A vertical stack of prose with a consistent rhythm. */
export function NoteBody() {
  return (
    <Stack gap={8} style={panel}>
      <Text variant="heading">Sprint retro</Text>
      <Text variant="caption" tone="tertiary">June 14 · 4 min read</Text>
      <Text variant="body">
        We shipped the field-level sync engine and cut conflict resolution errors to
        near zero. Next up: onboarding polish and the mobile share sheet.
      </Text>
      <Text variant="body">
        Blockers stayed low all week. The team wants to protect Friday afternoons for
        deep work going forward.
      </Text>
    </Stack>
  );
}

/** align="center" centers each stacked child horizontally. */
export function CenteredMeta() {
  return (
    <Stack gap={8} align="center" style={panel}>
      <Icon name="today" size={22} color={colors.accent} />
      <Text variant="title">8 tasks due today</Text>
      <Badge label="3 overdue" tone="accent" />
    </Stack>
  );
}

/** A checklist as a stack of labeled rows. */
export function Checklist() {
  return (
    <Stack gap={10} style={panel}>
      <Row gap={8} align="center">
        <Icon name="check" size={16} color={colors.success} />
        <Text variant="body" tone="tertiary">Draft the release notes</Text>
      </Row>
      <Row gap={8} align="center">
        <Icon name="check" size={16} color={colors.success} />
        <Text variant="body" tone="tertiary">Tag the v2.4.0 build</Text>
      </Row>
      <Row gap={8} align="center">
        <Icon name="dot" size={16} color={colors.textTertiary} />
        <Text variant="body">Announce in the team channel</Text>
      </Row>
    </Stack>
  );
}
