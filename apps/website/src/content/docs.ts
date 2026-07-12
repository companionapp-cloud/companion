import type { IconName } from "@companion/design-system";

// Docs content, sourced from content/docs/*.md. Each markdown file is compiled by
// metro.transformer.js into { slug, frontmatter, html, toc } and enumerated here
// with require.context, so adding a doc is just dropping in a new .md file.

export interface DocFrontmatter {
  title: string;
  group: string;
  groupIcon: IconName;
  groupOrder: number;
  order: number;
  excerpt: string;
  featured?: boolean;
  badge?: string;
  readTime?: string;
  updated?: string;
  related?: string[];
}

export interface TocEntry {
  id: string;
  text: string;
}

export interface Doc {
  slug: string;
  frontmatter: DocFrontmatter;
  html: string;
  toc: TocEntry[];
}

// Metro/Expo enables require.context; the ambient type lives in
// src/types/require-context.d.ts.
const ctx = (require as unknown as { context: (dir: string, deep: boolean, filter: RegExp) => { keys(): string[]; (id: string): Doc } }).context(
  "../../content/docs",
  false,
  /\.md$/,
);

const docs: Doc[] = ctx
  .keys()
  .map((key) => {
    const mod = ctx(key);
    return { slug: mod.slug, frontmatter: mod.frontmatter, html: mod.html, toc: mod.toc };
  })
  .sort(
    (a, b) =>
      a.frontmatter.groupOrder - b.frontmatter.groupOrder || a.frontmatter.order - b.frontmatter.order,
  );

export function getAllDocs(): Doc[] {
  return docs;
}

export function getDoc(slug: string): Doc | undefined {
  return docs.find((d) => d.slug === slug);
}

export interface DocGroup {
  title: string;
  icon: IconName;
  order: number;
  featured?: Doc;
  items: Doc[];
}

/** Docs bucketed by their `group`, ordered by `groupOrder` then `order`. */
export function getGroups(): DocGroup[] {
  const map = new Map<string, DocGroup>();
  for (const doc of docs) {
    const { group, groupIcon, groupOrder } = doc.frontmatter;
    let g = map.get(group);
    if (!g) {
      g = { title: group, icon: groupIcon, order: groupOrder, items: [] };
      map.set(group, g);
    }
    if (doc.frontmatter.featured && !g.featured) g.featured = doc;
    else g.items.push(doc);
  }
  return [...map.values()].sort((a, b) => a.order - b.order);
}

export interface SearchEntry {
  slug: string;
  group: string;
  title: string;
  excerpt: string;
}

/** Flat list for the docs search box. */
export function getSearchIndex(): SearchEntry[] {
  return docs.map((d) => ({
    slug: d.slug,
    group: d.frontmatter.group,
    title: d.frontmatter.title,
    excerpt: d.frontmatter.excerpt,
  }));
}
