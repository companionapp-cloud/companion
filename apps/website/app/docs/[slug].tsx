import { Badge, Icon } from "@companion/design-system";
import { useLocalSearchParams } from "expo-router";
import { usePostHog } from "posthog-js/react";
import { FeedbackRow } from "../../src/components/FeedbackRow";
import { SiteFooter } from "../../src/components/SiteFooter";
import { SiteHeader } from "../../src/components/SiteHeader";
import { getAllDocs, getDoc } from "../../src/content/docs";

// One static page per markdown file in content/docs. Expo Router pre-renders each
// slug returned here during `expo export`.
export function generateStaticParams() {
  return getAllDocs().map((doc) => ({ slug: doc.slug }));
}

export default function DocArticle() {
  const posthog = usePostHog();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const doc = getDoc(slug);

  if (!doc) {
    return (
      <div>
        <SiteHeader
          links={[
            { label: "All docs", href: "/docs", variant: "ghost" },
            { label: "Contact us", href: "/contact", variant: "secondary" },
          ]}
        />
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "96px 24px", textAlign: "center" }}>
          <h1 style={{ fontFamily: "'Geist', sans-serif", fontSize: 32, color: "#1a1a18" }}>Article not found</h1>
          <p style={{ color: "#595954", fontSize: 17 }}>
            The doc you're looking for doesn't exist. <a href="/docs">Browse all docs</a>.
          </p>
        </div>
        <SiteFooter tone="sunken" />
      </div>
    );
  }

  const { frontmatter, html, toc } = doc;
  // Lift the first paragraph out as the lede so it can sit above the on-page nav
  // (matching the article design), leaving the rest of the body below it.
  const ledeMatch = /^\s*<p>([\s\S]*?)<\/p>/.exec(html);
  const lede = ledeMatch?.[1];
  const body = ledeMatch ? html.slice(ledeMatch[0].length) : html;

  const related = (frontmatter.related ?? [])
    .map((relSlug) => getDoc(relSlug))
    .filter((d): d is NonNullable<typeof d> => Boolean(d));

  return (
    <div>
      <SiteHeader
        sticky
        links={[
          { label: "All docs", href: "/docs", variant: "ghost" },
          { label: "Contact us", href: "/contact", variant: "secondary" },
        ]}
      />

      <div style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px 24px" }}>
        <div className="crumb" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#a7a7a1", marginBottom: 28 }}>
          <a href="/docs">Support</a>
          <span>/</span>
          <a href="/docs">{frontmatter.group}</a>
          <span>/</span>
          <span style={{ color: "#3e3e3a" }}>{frontmatter.title}</span>
        </div>

        <h1 style={articleTitle}>{frontmatter.title}</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
          {frontmatter.badge ? <Badge label={frontmatter.badge} tone="accent" /> : null}
          {frontmatter.readTime || frontmatter.updated ? (
            <span style={{ fontSize: 13, color: "#a7a7a1", fontFamily: "'Geist Mono', monospace" }}>
              {[frontmatter.readTime, frontmatter.updated ? `Updated ${frontmatter.updated}` : null]
                .filter(Boolean)
                .join(" · ")}
            </span>
          ) : null}
        </div>

        {lede ? (
          <p
            style={{ fontSize: 19, lineHeight: 1.65, color: "#595954", margin: "28px 0 0" }}
            dangerouslySetInnerHTML={{ __html: lede }}
          />
        ) : null}

        {toc.length > 0 ? (
          <div className="toc" style={{ margin: "36px 0 8px" }}>
            <div className="toc-title">On this page</div>
            <nav>
              {toc.map((entry) => (
                <a key={entry.id} href={`#${entry.id}`}>
                  {entry.text}
                </a>
              ))}
            </nav>
          </div>
        ) : null}
      </div>

      <div
        className="prose prose--article"
        style={{ maxWidth: 720, margin: "0 auto", padding: "8px 24px 40px" }}
        dangerouslySetInnerHTML={{ __html: body }}
      />

      <div style={{ maxWidth: 720, margin: "0 auto", padding: "24px 24px 8px" }}>
        <FeedbackRow />
      </div>

      {related.length > 0 ? (
        <div className="rel" style={{ maxWidth: 720, margin: "0 auto", padding: "32px 24px 64px" }}>
          <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em", color: "#a7a7a1", textTransform: "uppercase", marginBottom: 18 }}>
            Related articles
          </div>
          <div className="rel-grid">
            {related.map((rel) => (
              <a
                key={rel.slug}
                href={`/docs/${rel.slug}`}
                style={relCard}
                onClick={() =>
                  posthog.capture("doc_related_article_clicked", {
                    from_slug: slug,
                    to_slug: rel.slug,
                    to_title: rel.frontmatter.title,
                  })
                }
              >
                <span style={{ fontSize: 16, fontWeight: 600, color: "#1a1a18" }}>{rel.frontmatter.title}</span>
                <Icon name="chevronRight" size={18} color="#a7a7a1" />
              </a>
            ))}
          </div>
        </div>
      ) : null}

      <SiteFooter tone="sunken" />
    </div>
  );
}

const articleTitle: React.CSSProperties = {
  fontFamily: "'Geist', sans-serif",
  fontWeight: 600,
  fontSize: "clamp(32px, 6vw, 40px)",
  lineHeight: 1.1,
  letterSpacing: "-0.03em",
  color: "#1a1a18",
  margin: 0,
};

const relCard: React.CSSProperties = {
  padding: "18px 20px",
  border: "1px solid #e0e0dc",
  borderRadius: 14,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
};
