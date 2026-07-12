import { Stack, RailItem, Icon, colors } from "@companion/design-system";

/** The expanded sidebar rail with one active item. */
export function ExpandedRail() {
  return (
    <Stack gap={2} style={{ padding: 12, width: 232, backgroundColor: colors.surfaceApp }}>
      <RailItem expanded active label="Today" icon={<Icon name="today" size={18} color={colors.accent} />} />
      <RailItem expanded label="Notes" icon={<Icon name="notes" size={18} color={colors.textSecondary} />} />
      <RailItem expanded label="Tasks" icon={<Icon name="tasks" size={18} color={colors.textSecondary} />} />
      <RailItem expanded label="Calendar" icon={<Icon name="calendar" size={18} color={colors.textSecondary} />} />
      <RailItem expanded label="Search" icon={<Icon name="search" size={18} color={colors.textSecondary} />} />
    </Stack>
  );
}

/** The collapsed rail — icon-only squares. */
export function CollapsedRail() {
  return (
    <Stack gap={2} align="center" style={{ padding: 12, width: 64, backgroundColor: colors.surfaceApp }}>
      <RailItem active label="Today" icon={<Icon name="today" size={18} color={colors.accent} />} />
      <RailItem label="Notes" icon={<Icon name="notes" size={18} color={colors.textSecondary} />} />
      <RailItem label="Tasks" icon={<Icon name="tasks" size={18} color={colors.textSecondary} />} />
      <RailItem label="Settings" icon={<Icon name="settings" size={18} color={colors.textSecondary} />} />
    </Stack>
  );
}

/** Active vs inactive, expanded. */
export function ActiveState() {
  return (
    <Stack gap={2} style={{ padding: 12, width: 232, backgroundColor: colors.surfaceApp }}>
      <RailItem expanded active label="Habits" icon={<Icon name="habits" size={18} color={colors.accent} />} />
      <RailItem expanded label="Graph" icon={<Icon name="graph" size={18} color={colors.textSecondary} />} />
    </Stack>
  );
}
