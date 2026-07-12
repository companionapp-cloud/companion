import { Row, Stack, Button, Icon } from "@companion/design-system";

/** The four intent variants side by side. */
export function Variants() {
  return (
    <Row gap={10} align="center" style={{ padding: 16 }}>
      <Button label="Save note" variant="primary" />
      <Button label="Cancel" variant="secondary" />
      <Button label="Dismiss" variant="ghost" />
      <Button label="Delete" variant="danger" />
    </Row>
  );
}

/** The three control sizes at the primary intent. */
export function Sizes() {
  return (
    <Row gap={10} align="center" style={{ padding: 16 }}>
      <Button label="Small" size="sm" />
      <Button label="Medium" size="md" />
      <Button label="Large" size="lg" />
    </Row>
  );
}

/** A leading icon composed into the label. */
export function WithIcon() {
  return (
    <Row gap={10} align="center" style={{ padding: 16 }}>
      <Button label="New note" variant="primary" icon={<Icon name="plus" size={16} color="#ffffff" />} />
      <Button label="Search" variant="secondary" icon={<Icon name="search" size={16} />} />
    </Row>
  );
}

/** Disabled state across the variants. */
export function Disabled() {
  return (
    <Row gap={10} align="center" style={{ padding: 16 }}>
      <Button label="Save note" variant="primary" disabled />
      <Button label="Cancel" variant="secondary" disabled />
    </Row>
  );
}
