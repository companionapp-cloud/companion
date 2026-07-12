import { BrandMark } from "@companion/design-system";

interface Props {
  /** sunken = warm gray (pages with white bodies), card = white (pages ending on gray). */
  tone?: "sunken" | "card";
}

const PRODUCTS = [
  "Companion for Mac",
  "Companion for iPhone",
  "Companion for Android",
  "Companion for Windows",
  "Companion for Linux",
];

export function SiteFooter({ tone = "sunken" }: Props) {
  return (
    <footer className={`site-footer site-footer--${tone}`}>
      <div className="cols">
        <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 280 }}>
          <a href="/" className="brand-link">
            <BrandMark size={28} />
            <span>Companion</span>
          </a>
          <div style={{ fontSize: 14, lineHeight: 1.55, color: "#7b7b75" }}>
            Your open source home for your life — notes, tasks, and habits in one calm workspace.
          </div>
          <div style={{ fontFamily: "'Geist Mono','Geist',monospace", fontSize: 12, letterSpacing: "0.03em", color: "#a7a7a1" }}>
            Open source · MIT licensed
          </div>
        </div>

        <div className="col">
          <div className="col-title">Products</div>
          {PRODUCTS.map((label) => (
            <a key={label} href="/">
              {label}
            </a>
          ))}
        </div>

        <div className="col">
          <div className="col-title">Support</div>
          <a href="/docs">Help</a>
          <a href="/contact">Contact</a>
          <a href="/docs">Documentation</a>
        </div>

        <div className="col">
          <div className="col-title">More</div>
          <a href="/privacy">Privacy Policy</a>
          <a href="/terms">Terms</a>
        </div>
      </div>

      <div className="rule" />
      <div className="legal">
        <span>© 2026 Companion. All rights reserved.</span>
        <span>Built in the open.</span>
      </div>
    </footer>
  );
}
