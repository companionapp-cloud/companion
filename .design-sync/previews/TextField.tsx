import { Stack, TextField, Text, colors } from "@companion/design-system";

/** The document title heading — large display variant. */
export function Title() {
  return (
    <Stack gap={4} style={{ padding: 16, width: 420, backgroundColor: colors.surfaceCard }}>
      <TextField variant="title" value="Migrating to the new sync engine" />
      <Text variant="caption" tone="tertiary">Draft · edited 2 hours ago</Text>
    </Stack>
  );
}

/** The flowing body variant used for note prose. */
export function Prose() {
  return (
    <Stack gap={4} style={{ padding: 16, width: 420, backgroundColor: colors.surfaceCard }}>
      <TextField
        variant="prose"
        multiline
        value="The sync layer now resolves conflicts field-by-field instead of replacing the whole document, so two people editing different parts of a note no longer clobber each other's work."
      />
    </Stack>
  );
}

/** Placeholder states for both variants on an empty note. */
export function Empty() {
  return (
    <Stack gap={8} style={{ padding: 16, width: 420, backgroundColor: colors.surfaceCard }}>
      <TextField variant="title" placeholder="Untitled note" />
      <TextField variant="prose" multiline placeholder="Start writing…" />
    </Stack>
  );
}

/** Title and body together — the note editor as it reads on the page. */
export function Document() {
  return (
    <Stack gap={8} style={{ padding: 20, width: 420, backgroundColor: colors.surfaceCard }}>
      <TextField variant="title" value="Q3 planning" />
      <TextField
        variant="prose"
        multiline
        value="Ship the calendar move for E2EE, close out the Obsidian importer, and start the LLM search milestone. Review priorities with the team on Tuesday."
      />
    </Stack>
  );
}
