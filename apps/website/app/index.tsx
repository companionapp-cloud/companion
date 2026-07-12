import { Badge } from "@companion/design-system";
import { usePostHog } from "posthog-js/react";
import { DocsIndex } from "../src/components/DocsIndex";
import { FeatureShowcase } from "../src/components/FeatureShowcase";
import { NavButtons } from "../src/components/NavButtons";
import { Seo } from "../src/components/Seo";
import { SiteFooter } from "../src/components/SiteFooter";
import { SiteHeader } from "../src/components/SiteHeader";

const GITHUB_URL = "https://github.com/chrisdmacrae/companion";
const PLATFORMS = ["macOS", "iOS", "Android", "Windows", "Linux"];

export default function Landing() {
  const posthog = usePostHog();

  return (
    <div style={{ background: "#fbfaf9" }}>
      <Seo
        title="Companion — Your open source home for your life"
        description="Companion turns your ideas into actionable tasks, connected notes, and repeatable habits — and uses the power of AI to make it a natural conversation."
        path="/"
      />
      {/* hero */}
      <div
        style={{
          position: "relative",
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          background: "radial-gradient(120% 90% at 50% -10%, #fff7f0 0%, #fbfaf9 46%, #fbfaf9 100%)",
        }}
      >
        <div aria-hidden className="hero-glow" style={glow} />

        <SiteHeader
          border={false}
          links={[
            { label: "Docs", href: "/docs", variant: "ghost" },
            {
              label: "Star on GitHub",
              href: GITHUB_URL,
              variant: "secondary",
              external: true,
              onClick: () => posthog.capture("github_repo_clicked", { location: "header" }),
            },
          ]}
        />

        <main
          style={{
            position: "relative",
            zIndex: 2,
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            padding: "32px 24px 80px",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 26, maxWidth: 780, width: "100%" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Badge label="OPEN SOURCE" tone="accent" />
              <Badge label="AI-FRIENDLY" tone="neutral" />
            </div>

            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20 }}>
              <h1 className="hero-title" style={{ margin: 0 }}>
                Your open source home for your life
              </h1>
              <p style={heroSub}>
                Companion turns your ideas into actionable tasks, connected notes, and repeatable habits — and uses the
                power of AI to make it a natural conversation.
              </p>
            </div>

            <div style={{ marginTop: 4 }}>
              <NavButtons
                gap={12}
                links={[
                  {
                    label: "Get started",
                    href: "/docs/getting-the-apps",
                    variant: "primary",
                    size: "lg",
                    onClick: () => posthog.capture("hero_cta_clicked", { label: "Get started" }),
                  },
                  {
                    label: "Learn more",
                    href: "#features",
                    variant: "secondary",
                    size: "lg",
                    onClick: () => posthog.capture("hero_cta_clicked", { label: "Learn more" }),
                  },
                ]}
              />
            </div>

            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, marginTop: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
                {PLATFORMS.map((p) => (
                  <span key={p} style={platformPill}>
                    {p}
                  </span>
                ))}
              </div>
              <div style={comingSoon}>macOS, iOS, Android, Windows &amp; Linux — coming soon</div>
            </div>
          </div>
        </main>
      </div>

      {/* features */}
      <section
        id="features"
        style={{ position: "relative", background: "#f5f5f3", borderTop: "1px solid #e0e0dc", padding: "96px 24px 104px" }}
      >
        <div style={{ maxWidth: 1040, margin: "0 auto", display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div className="eyebrow" style={{ marginBottom: 18 }}>
            WHAT'S INSIDE
          </div>
          <h2 className="section-title" style={{ margin: 0, maxWidth: "18ch" }}>
            Everything you need to learn, plan, and play
          </h2>
          <p style={sectionSub}>
            One calm workspace where your notes, tasks, and habits live together — and AI is always a message away.
          </p>

          <FeatureShowcase />
        </div>
      </section>

      {/* docs */}
      <section
        style={{ position: "relative", background: "#ffffff", borderTop: "1px solid #e0e0dc", padding: "96px 24px 112px" }}
      >
        <div style={{ maxWidth: 1040, margin: "0 auto" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 48 }}>
            <div className="eyebrow" style={{ marginBottom: 18 }}>
              DOCS
            </div>
            <h2 className="section-title" style={{ margin: 0, maxWidth: "20ch" }}>
              All the documentation you need to get started
            </h2>
            <p style={{ ...sectionSub, maxWidth: "50ch" }}>
              Clear, friendly guides for every corner of Companion — from your first note to running your own sync
              server.
            </p>
          </div>
          <DocsIndex />
        </div>
      </section>

      <SiteFooter tone="sunken" />
    </div>
  );
}

const glow: React.CSSProperties = {
  position: "absolute",
  top: "-6%",
  left: "50%",
  transform: "translateX(-50%)",
  width: 780,
  height: 780,
  borderRadius: "50%",
  background: "radial-gradient(circle, #f7680855 0%, #f768081f 40%, transparent 70%)",
  filter: "blur(10px)",
  pointerEvents: "none",
};

const heroSub: React.CSSProperties = {
  fontFamily: "'Geist', sans-serif",
  fontSize: 20,
  lineHeight: 1.55,
  color: "#6f6863",
  maxWidth: "60ch",
  textWrap: "pretty",
  margin: 0,
};

const platformPill: React.CSSProperties = {
  fontFamily: "'Geist', sans-serif",
  fontSize: 13,
  fontWeight: 500,
  color: "#78716c",
  padding: "5px 12px",
  border: "1px solid #eae5e0",
  borderRadius: 999,
  background: "#fff",
};

const comingSoon: React.CSSProperties = {
  fontFamily: "'Geist Mono', 'Geist', monospace",
  fontSize: 12.5,
  letterSpacing: "0.02em",
  color: "#a29e99",
};

const sectionSub: React.CSSProperties = {
  fontFamily: "'Geist', sans-serif",
  fontSize: 18,
  lineHeight: 1.55,
  color: "#595954",
  textAlign: "center",
  maxWidth: "52ch",
  margin: "18px 0 0",
};
