import type { CSSProperties, ReactNode } from "react";
import { usePostHog } from "posthog-js/react";
import { NavButtons, type NavLink } from "./NavButtons";
import { CLOUD_PORTAL_URL, CLOUD_PRICE, SELF_HOSTING_HREF } from "../content/pricing";

// The landing page's two sync paths: the server we host, and the one you host. Each card
// opens with a close-up of what that choice actually looks like — the app's sign-in dialog,
// or the command that starts your own server — then the price and where to go next.

export function SyncShowcase() {
  const posthog = usePostHog();
  const track = (option: "cloud" | "self_hosted", label: string) => () =>
    posthog.capture("sync_cta_clicked", { option, label });

  return (
    <div className="sync-grid">
      <SyncCard
        mock={<SignInMock />}
        title="Companion Cloud"
        price={`${CLOUD_PRICE} / month`}
        priceTone="accent"
        body="We run the sync server, so there's nothing to set up: subscribe, sign in from any Companion app with your email and password, and every device stays in step."
        ctas={[
          {
            label: "Use Companion Cloud",
            href: CLOUD_PORTAL_URL,
            variant: "primary",
            size: "lg",
            onClick: track("cloud", "Use Companion Cloud"),
          },
          {
            label: "See pricing",
            href: "/pricing",
            variant: "ghost",
            size: "lg",
            onClick: track("cloud", "See pricing"),
          },
        ]}
      />

      <SyncCard
        mock={<SelfHostMock />}
        title="Host it yourself"
        price="Free"
        priceTone="neutral"
        body="The sync server is open source and ships as a single container. Run it on your own hardware, point your devices at it, and the apps behave exactly as they do against our cloud."
        ctas={[
          {
            label: "Read the self-hosting guide",
            href: SELF_HOSTING_HREF,
            variant: "secondary",
            size: "lg",
            onClick: track("self_hosted", "Read the self-hosting guide"),
          },
        ]}
      />
    </div>
  );
}

function SyncCard({
  mock,
  title,
  price,
  priceTone,
  body,
  ctas,
}: {
  mock: ReactNode;
  title: string;
  price: string;
  priceTone: "accent" | "neutral";
  body: string;
  ctas: NavLink[];
}) {
  return (
    <article style={cardStyle}>
      <div style={{ borderBottom: "1px solid #e0e0dc", background: "#f5f5f3" }}>{mock}</div>
      <div style={{ padding: "22px 24px 26px", display: "flex", flexDirection: "column", flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <h3 style={cardTitle}>{title}</h3>
          <span style={priceTone === "accent" ? pricePillAccent : pricePillNeutral}>{price}</span>
        </div>
        <p style={cardBody}>{body}</p>
        <div style={{ marginTop: "auto", paddingTop: 20 }}>
          <NavButtons align="start" gap={10} links={ctas} />
        </div>
      </div>
    </article>
  );
}

/** The app's "Sign in to sync" dialog, Companion Cloud side: no server address to type. */
function SignInMock() {
  return (
    <div style={mockFrame}>
      <div style={dialog}>
        <div style={dialogTitle}>Sign in to sync</div>
        <div style={segmented}>
          <div style={segmentOn}>Companion Cloud</div>
          <div style={segmentOff}>Self-hosted</div>
        </div>
        <div style={fieldLabel}>Email</div>
        <div style={field}>you@example.com</div>
        <div style={{ ...fieldLabel, marginTop: 7 }}>Password</div>
        <div style={field}>••••••••</div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 11 }}>
          <span style={dialogButton}>Log in</span>
        </div>
      </div>
    </div>
  );
}

/** Starting your own server: the container command from the self-hosting guide, and the line
 *  the server prints once it's up. */
function SelfHostMock() {
  return (
    <div style={{ ...mockFrame, alignItems: "center" }}>
      <div style={terminal}>
        <div style={terminalBar}>
          <span style={{ ...dot, background: "#ff5f57" }} />
          <span style={{ ...dot, background: "#febc2e" }} />
          <span style={{ ...dot, background: "#28c840" }} />
          <span style={terminalName}>companion-server</span>
        </div>
        <div style={terminalBody}>
          <div style={terminalLine}>
            <span style={{ color: "#f76808" }}>$ </span>docker run -p 8080:8080 \
          </div>
          <div style={{ ...terminalLine, paddingLeft: 14 }}>-e DATABASE_URL=postgres://… \</div>
          <div style={{ ...terminalLine, paddingLeft: 14 }}>ghcr.io/companionapp-cloud/companion-server</div>
          <div style={{ ...terminalLine, color: "#7b7b75", marginTop: 8 }}>
            companion server listening addr=:8080
          </div>
          <div style={{ ...terminalLine, color: "#7b7b75" }}>store=postgres</div>
        </div>
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  background: "#ffffff",
  border: "1px solid #e0e0dc",
  borderRadius: 14,
};

const cardTitle: CSSProperties = {
  margin: 0,
  fontFamily: "'Geist', sans-serif",
  fontSize: 19,
  fontWeight: 600,
  lineHeight: 1.3,
  letterSpacing: "-0.015em",
  color: "#1a1a18",
};

const cardBody: CSSProperties = {
  margin: "10px 0 0",
  fontFamily: "'Geist', sans-serif",
  fontSize: 15.5,
  lineHeight: 1.55,
  color: "#595954",
  textWrap: "pretty",
};

const pricePillBase: CSSProperties = {
  fontFamily: "'Geist', sans-serif",
  fontSize: 13,
  fontWeight: 600,
  padding: "4px 11px",
  borderRadius: 999,
  whiteSpace: "nowrap",
};

const pricePillAccent: CSSProperties = {
  ...pricePillBase,
  color: "#b83a05",
  background: "#fff4ed",
  border: "1px solid #feccab",
};

const pricePillNeutral: CSSProperties = {
  ...pricePillBase,
  color: "#595954",
  background: "#f5f5f3",
  border: "1px solid #e0e0dc",
};

// ---- mock chrome ----------------------------------------------------------

const mockFrame: CSSProperties = {
  height: 220,
  padding: "16px 20px 0",
  display: "flex",
  justifyContent: "center",
  background: "#fafaf9",
  overflow: "hidden",
};

const dialog: CSSProperties = {
  width: "100%",
  maxWidth: 300,
  height: "fit-content",
  padding: "11px 13px 13px",
  background: "#ffffff",
  border: "1px solid #e0e0dc",
  borderRadius: 10,
  boxShadow: "0 1px 2px rgba(17,17,16,0.04), 0 10px 24px rgba(17,17,16,0.07)",
  fontFamily: "'Geist', sans-serif",
};

const dialogTitle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "#1a1a18",
  marginBottom: 9,
};

const segmented: CSSProperties = {
  display: "flex",
  gap: 2,
  padding: 2,
  background: "#ededea",
  borderRadius: 7,
  marginBottom: 12,
};

const segmentBase: CSSProperties = {
  flex: 1,
  textAlign: "center",
  fontSize: 11.5,
  lineHeight: "20px",
  borderRadius: 5,
  whiteSpace: "nowrap",
};

const segmentOn: CSSProperties = {
  ...segmentBase,
  fontWeight: 600,
  color: "#1a1a18",
  background: "#ffffff",
  boxShadow: "0 1px 2px rgba(17,17,16,0.08)",
};

const segmentOff: CSSProperties = { ...segmentBase, color: "#7b7b75" };

const fieldLabel: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  color: "#7b7b75",
  marginBottom: 3,
};

const field: CSSProperties = {
  height: 25,
  display: "flex",
  alignItems: "center",
  padding: "0 9px",
  fontSize: 11.5,
  color: "#7b7b75",
  background: "#ffffff",
  border: "1px solid #e0e0dc",
  borderRadius: 6,
};

const dialogButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: 24,
  padding: "0 12px",
  fontSize: 11.5,
  fontWeight: 600,
  color: "#ffffff",
  background: "#f76808",
  borderRadius: 6,
};

const terminal: CSSProperties = {
  width: "100%",
  maxWidth: 380,
  background: "#ffffff",
  border: "1px solid #e0e0dc",
  borderRadius: 10,
  overflow: "hidden",
  boxShadow: "0 1px 2px rgba(17,17,16,0.04), 0 10px 24px rgba(17,17,16,0.07)",
};

const terminalBar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  height: 28,
  padding: "0 10px",
  background: "linear-gradient(#f8f8f6,#f1f1ee)",
  borderBottom: "1px solid #e0e0dc",
};

const dot: CSSProperties = { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 };

const terminalName: CSSProperties = {
  marginLeft: 6,
  fontFamily: "'Geist Mono', monospace",
  fontSize: 11,
  color: "#a7a7a1",
};

const terminalBody: CSSProperties = { padding: "12px 12px 14px" };

const terminalLine: CSSProperties = {
  fontFamily: "'Geist Mono', monospace",
  fontSize: 11.5,
  lineHeight: 1.7,
  color: "#3e3e3a",
  whiteSpace: "pre",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
