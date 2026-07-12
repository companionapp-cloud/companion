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

/** A toolbar with a title lockup on the left and icon actions on the right. */
export function IconActions() {
  return (
    <Stack style={{ height: 240, width: 460 }}>
      <Frame
        toolbar={
          <Toolbar>
            <FrameTitle icon={<Icon name="folder" size={18} color={colors.accent} />}>
              Projects
            </FrameTitle>
            <Row gap={4} align="center" style={{ marginLeft: "auto" }}>
              <IconButton label="Search">
                <Icon name="search" size={18} />
              </IconButton>
              <IconButton label="Sort">
                <Icon name="settings" size={18} />
              </IconButton>
              <IconButton label="Collapse panel">
                <Icon name="panelLeft" size={18} />
              </IconButton>
            </Row>
          </Toolbar>
        }
      >
        <Stack gap={8} style={{ padding: 24 }}>
          <Text variant="body" tone="secondary">
            Three active projects, sorted by most recently edited.
          </Text>
        </Stack>
      </Frame>
    </Stack>
  );
}

/** A toolbar that pairs the title with a primary button. */
export function WithPrimary() {
  return (
    <Stack style={{ height: 240, width: 460 }}>
      <Frame
        toolbar={
          <Toolbar>
            <FrameTitle icon={<Icon name="calendar" size={18} color={colors.accent} />}>
              This week
            </FrameTitle>
            <Row gap={6} align="center" style={{ marginLeft: "auto" }}>
              <IconButton label="Previous week">
                <Icon name="chevronLeft" size={18} />
              </IconButton>
              <IconButton label="Next week">
                <Icon name="chevronRight" size={18} />
              </IconButton>
              <Button label="New event" variant="primary" size="sm" />
            </Row>
          </Toolbar>
        }
      >
        <Stack gap={8} style={{ padding: 24 }}>
          <Text variant="body" tone="secondary">
            5 events scheduled between Monday and Friday.
          </Text>
        </Stack>
      </Frame>
    </Stack>
  );
}
