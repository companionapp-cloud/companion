import { Center, Stack, Text, Button, Icon, colors, radius } from "@companion/design-system";

/** Center places a single card in the middle of the available space. */
export function CenteredCard() {
  return (
    <Stack
      style={{
        height: 240,
        margin: 16,
        backgroundColor: colors.surfaceApp,
        borderRadius: radius.lg,
      }}
    >
      <Center>
        <Stack
          gap={8}
          align="center"
          style={{
            width: 240,
            padding: 20,
            backgroundColor: colors.surfaceCard,
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: colors.borderSubtle,
          }}
        >
          <Icon name="notes" size={22} color={colors.accent} />
          <Text variant="title">No note selected</Text>
          <Text variant="caption" tone="tertiary">
            Pick a note from the list to start reading.
          </Text>
        </Stack>
      </Center>
    </Stack>
  );
}

/** An empty-state call to action, centered in a bounded panel. */
export function EmptyState() {
  return (
    <Stack
      style={{
        height: 240,
        margin: 16,
        backgroundColor: colors.surfaceApp,
        borderRadius: radius.lg,
      }}
    >
      <Center>
        <Stack gap={12} align="center">
          <Text variant="heading">Your inbox is clear</Text>
          <Text variant="caption" tone="tertiary">
            Nothing left to sort today.
          </Text>
          <Button label="New note" variant="primary" icon={<Icon name="plus" size={16} color="#ffffff" />} />
        </Stack>
      </Center>
    </Stack>
  );
}
