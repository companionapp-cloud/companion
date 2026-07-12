import { Badge, Icon, ListRow, Text, colors, radius, space } from "@companion/design-system";
import { usePostHog } from "posthog-js/react";
import { getGroups, type Doc, type DocGroup } from "../content/docs";

// Docs overview cards on the landing page — derived from the same markdown
// collection as the docs site, so it never drifts from the real content.

// Show the first two groups as cards.
const GROUPS = getGroups().slice(0, 2);

function docsFor(group: DocGroup): Doc[] {
  return group.featured ? [group.featured, ...group.items] : group.items;
}

function Group({ group }: { group: DocGroup }) {
  const posthog = usePostHog();
  const docs = docsFor(group);
  return (
    <div
      style={{
        background: colors.surfaceCard,
        border: `1px solid ${colors.borderSubtle}`,
        borderRadius: radius.xl,
        padding: space.md,
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: space.md, padding: `${space.md}px ${space.lg}px` }}>
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: radius.md,
            background: colors.accentSoft,
            border: `1px solid ${colors.accentSoftBorder}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Icon name={group.icon} size={18} color={colors.accent} />
        </div>
        <Text variant="title">{group.title}</Text>
        <div style={{ marginLeft: "auto" }}>
          <Badge label={`${docs.length} ${docs.length === 1 ? "guide" : "guides"}`} tone="neutral" />
        </div>
      </div>
      <div style={{ height: 1, background: colors.borderSubtle, margin: `2px ${space.xs}px ${space.xs}px` }} />
      <div style={{ display: "flex", flexDirection: "column" }}>
        {docs.map((doc) => (
          <ListRow
            key={doc.slug}
            title={doc.frontmatter.title}
            subtitle={doc.frontmatter.excerpt}
            icon={<Icon name={doc.frontmatter.groupIcon} size={18} color={colors.textSecondary} />}
            hasChildren
            onPress={() => {
              posthog.capture("doc_article_opened", {
                slug: doc.slug,
                title: doc.frontmatter.title,
                group: group.title,
                source: "homepage_index",
              });
              window.location.href = `/docs/${doc.slug}`;
            }}
          />
        ))}
      </div>
    </div>
  );
}

export function DocsIndex() {
  return (
    <div className="docs-index">
      {GROUPS.map((group) => (
        <Group key={group.title} group={group} />
      ))}
    </div>
  );
}
