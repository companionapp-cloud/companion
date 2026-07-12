import { Stack, Row, Text } from "@companion/design-system";

/** Every type ramp variant, top to bottom. */
export function Variants() {
  return (
    <Stack gap={10} style={{ padding: 16 }}>
      <Text variant="display">Ship your best ideas</Text>
      <Text variant="heading">Weekly review</Text>
      <Text variant="title">Project notes</Text>
      <Text variant="body">
        The body variant carries running prose — the default reading size for note
        content and descriptions across the app.
      </Text>
      <Text variant="label">List row label</Text>
      <Text variant="caption">Updated 3 hours ago</Text>
      <Text variant="mono">2024-06-14 · id_8f2a9c</Text>
    </Stack>
  );
}

/** Tone maps the same text onto the semantic color roles. */
export function Tones() {
  return (
    <Stack gap={6} style={{ padding: 16 }}>
      <Text variant="body" tone="default">Default — primary reading text</Text>
      <Text variant="body" tone="secondary">Secondary — supporting detail</Text>
      <Text variant="body" tone="tertiary">Tertiary — metadata and hints</Text>
      <Text variant="body" tone="accent">Accent — links and emphasis</Text>
      <Text variant="body" tone="danger">Danger — destructive or error</Text>
    </Stack>
  );
}

/** A realistic block: heading, prose, and a mono timestamp together. */
export function Article() {
  return (
    <Stack gap={8} style={{ padding: 20, maxWidth: 420 }}>
      <Text variant="heading">Migrating to the new sync engine</Text>
      <Text variant="caption" tone="tertiary">Draft · 4 min read</Text>
      <Text variant="body">
        The sync layer now resolves conflicts field-by-field instead of replacing the
        whole document. In practice that means two people editing different parts of the
        same note no longer clobber each other's work.
      </Text>
      <Row gap={8} align="center">
        <Text variant="mono" tone="tertiary">v2.4.0</Text>
        <Text variant="caption" tone="secondary">shipped last Tuesday</Text>
      </Row>
    </Stack>
  );
}
