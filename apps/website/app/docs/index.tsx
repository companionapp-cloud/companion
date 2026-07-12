import { Icon } from "@companion/design-system";
import { DocsSearch } from "../../src/components/DocsSearch";
import { NavButtons } from "../../src/components/NavButtons";
import { Seo } from "../../src/components/Seo";
import { SiteFooter } from "../../src/components/SiteFooter";
import { SiteHeader } from "../../src/components/SiteHeader";
import { getGroups } from "../../src/content/docs";

const groups = getGroups();

export default function DocsHome() {
  return (
    <div className="docpage">
      <Seo
        title="Docs — Companion"
        description="Guides, tutorials, and answers for every part of Companion — from your first note to running your own sync server."
        path="/docs"
      />
      <SiteHeader
        sticky
        links={[
          { label: "Home", href: "/", variant: "ghost" },
          { label: "Contact us", href: "/contact", variant: "secondary" },
        ]}
      />

      <section
        style={{
          padding: "80px 24px 56px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          background: "linear-gradient(#fff7f0, #ffffff)",
          borderBottom: "1px solid #ededea",
        }}
      >
        <div className="eyebrow" style={{ marginBottom: 16 }}>
          SUPPORT
        </div>
        <h1 style={docsHeroTitle}>How can we help?</h1>
        <p style={docsHeroSub}>Guides, tutorials, and answers for every part of Companion.</p>

        <DocsSearch />

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 18 }}>
          <span style={{ fontFamily: "'Geist', sans-serif", fontSize: 13, color: "#a7a7a1" }}>Popular:</span>
          {["sync", "the graph", "importing", "shortcuts"].map((t) => (
            <a key={t} href="#" className="chip">
              {t}
            </a>
          ))}
        </div>
      </section>

      <main style={{ maxWidth: 840, margin: "0 auto", padding: "16px 24px 40px" }}>
        {groups.map((group, i) => (
          <div
            key={group.title}
            style={{ padding: "44px 0", borderBottom: i === groups.length - 1 ? "none" : "1px solid #ededea" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
              <div style={groupIcon}>
                <Icon name={group.icon} size={19} color="#f76808" />
              </div>
              <div style={groupTitle}>{group.title}</div>
            </div>

            {group.featured ? (
              <a href={`/docs/${group.featured.slug}`} style={{ display: "block", marginBottom: 24 }}>
                <div className="t" style={{ fontSize: 18, marginBottom: 4 }}>
                  {group.featured.frontmatter.title}
                </div>
                <div className="d" style={{ fontSize: 15 }}>
                  {group.featured.frontmatter.excerpt}
                </div>
              </a>
            ) : null}

            <div className="group-grid">
              {group.items.map((doc) => (
                <a key={doc.slug} href={`/docs/${doc.slug}`}>
                  <div className="t" style={{ fontSize: 16 }}>
                    {doc.frontmatter.title}
                  </div>
                </a>
              ))}
            </div>
          </div>
        ))}
      </main>

      <section
        style={{
          padding: "56px 24px 72px",
          background: "#f5f5f3",
          borderTop: "1px solid #e0e0dc",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 18,
        }}
      >
        <div style={{ fontFamily: "'Geist', sans-serif", fontSize: 20, fontWeight: 600, color: "#1a1a18" }}>
          Didn't find what you were looking for?
        </div>
        <NavButtons links={[{ label: "Contact us", href: "/contact", variant: "primary", size: "lg" }]} />
      </section>

      <SiteFooter tone="card" />
    </div>
  );
}

const docsHeroTitle: React.CSSProperties = {
  fontFamily: "'Geist', sans-serif",
  fontWeight: 600,
  fontSize: "clamp(34px, 6vw, 46px)",
  lineHeight: 1.05,
  letterSpacing: "-0.03em",
  color: "#1a1a18",
  textAlign: "center",
  margin: 0,
};

const docsHeroSub: React.CSSProperties = {
  fontFamily: "'Geist', sans-serif",
  fontSize: 18,
  lineHeight: 1.5,
  color: "#595954",
  textAlign: "center",
  maxWidth: "48ch",
  margin: "16px 0 0",
};

const groupIcon: React.CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 10,
  background: "#fff4ed",
  border: "1px solid #feccab",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const groupTitle: React.CSSProperties = {
  fontFamily: "'Geist', sans-serif",
  fontSize: 26,
  fontWeight: 600,
  letterSpacing: "-0.02em",
  color: "#1a1a18",
};
