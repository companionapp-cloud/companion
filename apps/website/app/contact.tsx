import { ContactForm } from "../src/components/ContactForm";
import { SiteFooter } from "../src/components/SiteFooter";
import { SiteHeader } from "../src/components/SiteHeader";

const GITHUB_URL = "https://github.com/chrisdmacrae/companion";

export default function Contact() {
  return (
    <div>
      <SiteHeader
        links={[
          { label: "Docs", href: "/docs", variant: "ghost" },
          { label: "Home", href: "/", variant: "secondary" },
        ]}
      />

      <div style={{ maxWidth: 640, margin: "0 auto", padding: "64px 24px 88px" }}>
        <div className="eyebrow" style={{ marginBottom: 16 }}>
          CONTACT
        </div>
        <h1 style={title}>Get in touch</h1>
        <p style={sub}>Questions, ideas, or a bug to report? Send us a note and we'll get back to you.</p>

        <div style={ghNote}>
          <div style={{ flexShrink: 0, marginTop: 2 }}>
            <svg width="26" height="26" viewBox="0 0 16 16" fill="#1a1a18" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
          </div>
          <div style={{ fontFamily: "'Geist', sans-serif", fontSize: 15, lineHeight: 1.6, color: "#3e3e3a" }}>
            <span style={{ fontWeight: 600, color: "#1a1a18" }}>Companion is built in the open.</span> Before reaching
            out, browse our{" "}
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>
              GitHub repository
            </a>{" "}
            for the roadmap, open issues, and discussions — your question or idea may already be there.
          </div>
        </div>

        <ContactForm />
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

const sub: React.CSSProperties = {
  fontFamily: "'Geist', sans-serif",
  fontSize: 18,
  lineHeight: 1.55,
  color: "#595954",
  margin: "14px 0 0",
};

const ghNote: React.CSSProperties = {
  display: "flex",
  gap: 16,
  alignItems: "flex-start",
  marginTop: 32,
  padding: "20px 22px",
  background: "#f5f5f3",
  border: "1px solid #e0e0dc",
  borderRadius: 16,
};
