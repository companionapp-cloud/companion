import { Stack, ListRow, Icon } from "@companion/design-system";
import { colors } from "@companion/design-system";

/** A navigation list: icons, selection, subtitles, counts, and drill-in chevrons. */
export function Navigation() {
  return (
    <Stack gap={2} style={{ padding: 12, width: 320, backgroundColor: colors.surfaceCard }}>
      <ListRow title="Today" icon={<Icon name="today" size={18} color={colors.accent} />} trailing="8" />
      <ListRow
        title="Inbox"
        icon={<Icon name="notes" size={18} />}
        subtitle="Unsorted notes and quick captures"
        selected
      />
      <ListRow title="Projects" icon={<Icon name="folder" size={18} />} hasChildren />
      <ListRow title="Reading" icon={<Icon name="file" size={18} />} subtitle="12 saved articles" trailing="12" />
      <ListRow title="Archive" icon={<Icon name="folder" size={18} />} hasChildren />
    </Stack>
  );
}

/** Single- vs two-line rows. */
export function Density() {
  return (
    <Stack gap={2} style={{ padding: 12, width: 320, backgroundColor: colors.surfaceCard }}>
      <ListRow title="Weekly review" icon={<Icon name="calendar" size={18} />} />
      <ListRow
        title="Q3 planning"
        subtitle="Draft · edited 2 hours ago"
        icon={<Icon name="tasks" size={18} />}
        trailing="3"
      />
    </Stack>
  );
}
