import { Row, Stack, Icon, colors } from "@companion/design-system";

const NAV = ["chat", "notes", "calendar", "today", "bell", "tasks", "habits", "search", "folder", "file", "graph", "settings"] as const;
const EDITOR = ["bold", "italic", "strikethrough", "code", "codeBlock", "quote", "listBullet", "listOrdered", "table", "link", "check", "plus"] as const;

/** The navigation icon set at the accent color. */
export function NavigationSet() {
  return (
    <Row gap={16} align="center" style={{ padding: 16, flexWrap: "wrap", maxWidth: 360, backgroundColor: colors.surfaceCard }}>
      {NAV.map((name) => (
        <Icon key={name} name={name} size={22} color={colors.accent} />
      ))}
    </Row>
  );
}

/** The editor toolbar icons in neutral ink. */
export function EditorSet() {
  return (
    <Row gap={16} align="center" style={{ padding: 16, flexWrap: "wrap", maxWidth: 360, backgroundColor: colors.surfaceCard }}>
      {EDITOR.map((name) => (
        <Icon key={name} name={name} size={20} color={colors.textSecondary} />
      ))}
    </Row>
  );
}

/** The same icon across the sizes it renders at. */
export function Sizes() {
  return (
    <Row gap={16} align="center" style={{ padding: 16, backgroundColor: colors.surfaceCard }}>
      <Icon name="calendar" size={16} color={colors.accent} />
      <Icon name="calendar" size={22} color={colors.accent} />
      <Icon name="calendar" size={28} color={colors.accent} />
    </Row>
  );
}
