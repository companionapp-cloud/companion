import { Row, Tab, Icon, colors } from "@companion/design-system";

/** A row of document tabs with one active. */
export function TabStrip() {
  return (
    <Row gap={4} align="center" style={{ padding: 16, backgroundColor: colors.surfaceApp }}>
      <Tab label="Weekly review" active icon={<Icon name="notes" size={13} color={colors.textPrimary} />} />
      <Tab label="Q3 planning" icon={<Icon name="tasks" size={13} color={colors.textTertiary} />} />
      <Tab label="July 12" icon={<Icon name="calendar" size={13} color={colors.textTertiary} />} />
    </Row>
  );
}

/** Active vs inactive, side by side. */
export function ActiveState() {
  return (
    <Row gap={4} align="center" style={{ padding: 16, backgroundColor: colors.surfaceApp }}>
      <Tab label="Active tab" active icon={<Icon name="file" size={13} color={colors.textPrimary} />} />
      <Tab label="Inactive tab" icon={<Icon name="file" size={13} color={colors.textTertiary} />} />
    </Row>
  );
}

/** Tabs with a close affordance. */
export function Closable() {
  return (
    <Row gap={4} align="center" style={{ padding: 16, backgroundColor: colors.surfaceApp }}>
      <Tab
        label="Meeting notes"
        active
        icon={<Icon name="notes" size={13} color={colors.textPrimary} />}
        onClose={() => {}}
      />
      <Tab
        label="Roadmap"
        icon={<Icon name="folder" size={13} color={colors.textTertiary} />}
        onClose={() => {}}
      />
    </Row>
  );
}
