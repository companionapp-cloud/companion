import type { ReactNode } from "react";
import { Seo } from "./Seo";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";

interface Props {
  heading: string;
  updated: string;
  intro: string;
  toc: { href: string; label: string }[];
  /** Route path for canonical/OG (e.g. "/privacy"). */
  path: string;
  children: ReactNode;
}

/** Shared shell for the Privacy and Terms pages. */
export function LegalPage({ heading, updated, intro, toc, path, children }: Props) {
  return (
    <div>
      <Seo title={`${heading} — Companion`} description={intro} path={path} />
      <SiteHeader
        links={[
          { label: "Docs", href: "/docs", variant: "ghost" },
          { label: "Contact us", href: "/contact", variant: "secondary" },
        ]}
      />

      <div style={{ maxWidth: 720, margin: "0 auto", padding: "64px 24px 8px" }}>
        <div className="eyebrow" style={{ marginBottom: 16 }}>
          LEGAL
        </div>
        <h1 style={title}>{heading}</h1>
        <div style={{ fontFamily: "'Geist Mono', monospace", fontSize: 13, color: "#a7a7a1", marginTop: 14 }}>
          Last updated · {updated}
        </div>
        <p style={{ fontSize: 19, lineHeight: 1.6, color: "#595954", margin: "24px 0 0" }}>{intro}</p>

        <div className="toc" style={{ margin: "32px 0 8px" }}>
          <div className="toc-title">On this page</div>
          <nav>
            {toc.map((item) => (
              <a key={item.href} href={item.href}>
                {item.label}
              </a>
            ))}
          </nav>
        </div>
      </div>

      <div className="prose" style={{ maxWidth: 720, margin: "0 auto", padding: "8px 24px 48px" }}>
        {children}
      </div>

      <SiteFooter tone="sunken" />
    </div>
  );
}

const title: React.CSSProperties = {
  fontFamily: "'Geist', sans-serif",
  fontWeight: 600,
  fontSize: "clamp(34px, 6vw, 42px)",
  lineHeight: 1.08,
  letterSpacing: "-0.03em",
  color: "#1a1a18",
  margin: 0,
};
