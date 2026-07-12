import {
  Frame,
  Toolbar,
  FrameTitle,
  Stack,
  Row,
  Text,
  Button,
  IconButton,
  Icon,
  colors,
} from "@companion/design-system";

/** The full Frame chrome: a blended toolbar over a floating white content card. */
export function NoteFrame() {
  return (
    <Stack style={{ height: 300, width: 460 }}>
      <Frame
        toolbar={
          <Toolbar>
            <FrameTitle icon={<Icon name="notes" size={18} color={colors.accent} />}>
              Sprint retro
            </FrameTitle>
            <Row gap={4} align="center" style={{ marginLeft: "auto" }}>
              <IconButton label="Share">
                <Icon name="link" size={18} />
              </IconButton>
              <IconButton label="More">
                <Icon name="moreH" size={18} />
              </IconButton>
            </Row>
          </Toolbar>
        }
      >
        <Stack gap={8} style={{ padding: 24 }}>
          <Text variant="heading">Sprint retro</Text>
          <Text variant="caption" tone="tertiary">June 14 · updated 2 hours ago</Text>
          <Text variant="body">
            We shipped the field-level sync engine and cut conflict resolution errors to
            near zero. Next up: onboarding polish and the mobile share sheet.
          </Text>
        </Stack>
      </Frame>
    </Stack>
  );
}

/** A Frame whose toolbar carries a primary action. */
export function TaskFrame() {
  return (
    <Stack style={{ height: 300, width: 460 }}>
      <Frame
        toolbar={
          <Toolbar>
            <FrameTitle icon={<Icon name="tasks" size={18} color={colors.accent} />}>
              Today
            </FrameTitle>
            <Row style={{ marginLeft: "auto" }}>
              <Button label="New task" variant="primary" size="sm" icon={<Icon name="plus" size={14} color="#ffffff" />} />
            </Row>
          </Toolbar>
        }
      >
        <Stack gap={12} style={{ padding: 24 }}>
          <Row gap={8} align="center">
            <Icon name="check" size={16} color={colors.success} />
            <Text variant="body" tone="tertiary">Review the sync migration PR</Text>
          </Row>
          <Row gap={8} align="center">
            <Icon name="dot" size={16} color={colors.textTertiary} />
            <Text variant="body">Draft the v2.4.0 release notes</Text>
          </Row>
          <Row gap={8} align="center">
            <Icon name="dot" size={16} color={colors.textTertiary} />
            <Text variant="body">Prep the weekly review deck</Text>
          </Row>
        </Stack>
      </Frame>
    </Stack>
  );
}
