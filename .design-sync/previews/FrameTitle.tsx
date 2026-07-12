import {
  Frame,
  Toolbar,
  FrameTitle,
  Stack,
  Text,
  Icon,
  colors,
} from "@companion/design-system";

/** The title lockup: an accent icon beside the frame's name. */
export function NoteTitle() {
  return (
    <Stack style={{ height: 220, width: 440 }}>
      <Frame
        toolbar={
          <Toolbar>
            <FrameTitle icon={<Icon name="notes" size={18} color={colors.accent} />}>
              Meeting notes
            </FrameTitle>
          </Toolbar>
        }
      >
        <Stack gap={6} style={{ padding: 24 }}>
          <Text variant="body" tone="secondary">
            The lockup keeps the section icon and name aligned as a single unit.
          </Text>
        </Stack>
      </Frame>
    </Stack>
  );
}

/** A long title truncates to one line inside the lockup. */
export function LongTitle() {
  return (
    <Stack style={{ height: 220, width: 340 }}>
      <Frame
        toolbar={
          <Toolbar>
            <FrameTitle icon={<Icon name="today" size={18} color={colors.accent} />}>
              Q3 planning and roadmap review — draft
            </FrameTitle>
          </Toolbar>
        }
      >
        <Stack gap={6} style={{ padding: 24 }}>
          <Text variant="body" tone="secondary">
            Titles clamp to a single line so the toolbar height stays fixed.
          </Text>
        </Stack>
      </Frame>
    </Stack>
  );
}
