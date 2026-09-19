import type { ReactNode } from "react";
import { usePostHog } from "posthog-js/react";
import { Button, Icon, type IconName } from "../src/ds";
import { NavButtons } from "../src/components/NavButtons";
import { Seo } from "../src/components/Seo";
import { SiteFooter } from "../src/components/SiteFooter";
import { SiteHeader } from "../src/components/SiteHeader";
import {
  CLOUD_CURRENCY,
  CLOUD_DOCS_HREF,
  CLOUD_PERIOD,
  CLOUD_PORTAL_URL,
  CLOUD_PRICE,
  SELF_HOSTING_HREF,
} from "../src/content/pricing";

const GITHUB_URL = "https://github.com/chrisdmacrae/companion";
const WEB_APP_URL = "https://web.companionapp.cloud";

// The two ways to sync, side by side. Everything else about Companion is free either way, so
// these cards are the whole price list: the hosted server, and the one you run yourself.
interface Plan {
  id: "cloud" | "self_hosted";
  icon: IconName;
  name: string;
  blurb: string;
  price: string;
  /** Currency beside the amount — omitted for the free column, which has no amount. */
  currency?: string;
  period: string;
  primary: { label: string; href: string; external?: boolean };
  secondary: { label: string; href: string; external?: boolean };
  features: string[];
}

const PLANS: Plan[] = [
  {
    id: "cloud",
    icon: "cloud",
    name: "Companion Cloud",
    blurb: "We run the sync server. You sign in and forget about it.",
    price: CLOUD_PRICE,
    currency: CLOUD_CURRENCY,
    period: CLOUD_PERIOD,
    primary: { label: "Sign up", href: CLOUD_PORTAL_URL },
    secondary: { label: "Learn more", href: CLOUD_DOCS_HREF },
    features: [
      "Sync across every device you sign in on",
      "End-to-end encrypted notes and tasks",
      "Repeating tasks and reminders",
      "Calendar subscriptions kept fresh",
      "File attachments that follow you",
      "Chat with your desktop agents from anywhere",
    ],
  },
  {
    id: "self_hosted",
    icon: "server",
    name: "Host it yourself",
    blurb: "The same server, on hardware you control.",
    price: "Free",
    period: "Open source, for as long as you run it",
    primary: { label: "Read the guide", href: SELF_HOSTING_HREF },
    secondary: { label: "View the source", href: GITHUB_URL, external: true },
    features: [
      "The same sync server we run",
      "The same end-to-end encryption",
      "One container — Postgres or SQLite",
      "Attachments on S3-compatible storage or disk",
      "Repeating tasks and calendar refreshes",
      "Your server, your accounts",
    ],
  },
];

const FAQS: { q: string; a: ReactNode }[] = [
  {
    q: "Do I need an account to use Companion?",
    a: (
      <p>
        No. The desktop and web apps work on their own, offline, with no sign-up — your notes, tasks and projects
        stay on the device you wrote them on. An account only comes into it when you want the same workspace on more
        than one device.
      </p>
    ),
  },
  {
    q: "What does Companion Cloud include?",
    a: (
      <p>
        Sync between all your devices, hosted by us — and with it the parts that need a server: repeating tasks,
        calendar feeds that refresh on their own, attachments on every device, and chatting with an{" "}
        <a href="/docs/chatting-with-companion">agent on your computer</a> from the web app.
      </p>
    ),
  },
  {
    q: "How is hosting it myself different?",
    a: (
      <p>
        It's the same open-source sync server, with the same encryption, and the apps behave identically against it —
        you're just the host. What stays with the hosted cloud is the billing, the account portal and the admin
        back-office; on your own server, accounts are created from the app.{" "}
        <a href={SELF_HOSTING_HREF}>The guide</a> walks through it.
      </p>
    ),
  },
  {
    q: "Can you read my notes?",
    a: (
      <p>
        No. New accounts are end-to-end encrypted: your notes are encrypted on your device, and the server stores them
        without the ability to read them. It does see the bookkeeping it needs to do its job — due dates, reminder
        times, repeat rules, timestamps — which is how repeating tasks and reminders work server-side without handing
        over your content. <a href={`${CLOUD_DOCS_HREF}#what-s-encrypted-and-what-isn-t`}>The full list</a> is in the
        docs.
      </p>
    ),
  },
  {
    q: "Does the AI cost extra?",
    a: (
      <p>
        Not from us — Companion has no model of its own, so there's no AI subscription to buy. You bring an agent:
        Claude Code, Codex, Ollama or LM Studio on your own machine, or a cloud API with your own Anthropic or OpenAI
        key, billed by whoever runs that model.
      </p>
    ),
  },
  {
    q: "What happens if I cancel?",
    a: (
      <p>
        Companion keeps working. Your workspace lives on each device, so nothing disappears when a subscription ends —
        your devices simply stop syncing with each other until you subscribe again, or point them at a server of your
        own. You can also export everything as plain files from inside the app, any time.
      </p>
    ),
  },
  {
    q: "How do payments work?",
    a: (
      <p>
        Through Stripe, in the <a href={CLOUD_PORTAL_URL}>Companion Cloud portal</a> — that's where you subscribe, see
        your next charge and past invoices, and cancel. Cancelling takes effect at the end of the period you've
        already paid for, and can be undone until then.
      </p>
    ),
  },
];

export default function Pricing() {
  const posthog = usePostHog();

  return (
    <div style={{ background: "#fbfaf9" }}>
      <Seo
        title="Pricing — Companion"
        description="Companion is free, with no account needed. Add end-to-end encrypted sync for $1.99 a month with Companion Cloud, or host the open-source sync server yourself for free."
        path="/pricing"
      />

      {/* hero */}
      <div
        style={{
          position: "relative",
          overflow: "hidden",
          background: "radial-gradient(120% 90% at 50% -10%, #fff7f0 0%, #fbfaf9 46%, #fbfaf9 100%)",
        }}
      >
        <div aria-hidden className="hero-glow" style={glow} />

        <SiteHeader
          border={false}
          links={[
            { label: "Pricing", href: "/pricing", variant: "ghost" },
            { label: "Docs", href: "/docs", variant: "ghost" },
            {
              label: "Get started",
              href: WEB_APP_URL,
              variant: "secondary",
              onClick: () => posthog.capture("pricing_cta_clicked", { location: "header", label: "Get started" }),
            },
          ]}
        />

        <main
          style={{
            position: "relative",
            zIndex: 2,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            textAlign: "center",
            padding: "48px 24px 84px",
          }}
        >
          <div className="eyebrow" style={{ marginBottom: 20 }}>
            PRICING
          </div>
          <h1 className="price-title" style={{ margin: 0 }}>
            Companion is <span className="price-underline">free</span>.
          </h1>
          <p className="price-lines">
            No account needed.
            <br />
            Nothing held back.
          </p>
          <p style={heroSub}>
            Notes, tasks, projects, canvases and your own AI agents all run on your devices at no cost. The one thing
            we charge for is hosting sync — and you can host that yourself, free.
          </p>
          <div style={{ marginTop: 30 }}>
            <NavButtons
              gap={12}
              links={[
                {
                  label: "Get started",
                  href: WEB_APP_URL,
                  variant: "primary",
                  size: "lg",
                  onClick: () => posthog.capture("pricing_cta_clicked", { location: "hero", label: "Get started" }),
                },
                {
                  label: "Get the apps",
                  href: "/docs/getting-the-apps",
                  variant: "secondary",
                  size: "lg",
                  onClick: () => posthog.capture("pricing_cta_clicked", { location: "hero", label: "Get the apps" }),
                },
              ]}
            />
          </div>
        </main>
      </div>

      {/* plans */}
      <section
        id="sync"
        style={{ background: "#f5f5f3", borderTop: "1px solid #e0e0dc", padding: "88px 24px 104px" }}
      >
        <div style={{ maxWidth: 1040, margin: "0 auto", display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div className="eyebrow" style={{ marginBottom: 18 }}>
            SYNC
          </div>
          <h2 className="section-title" style={{ margin: 0, maxWidth: "18ch" }}>
            Add sync when you want it
          </h2>
          <p style={sectionSub}>
            Sync keeps every device in step, end-to-end encrypted, so the server holds your notes without being able
            to read them. Let us run it, or run it yourself — the apps behave the same either way.
          </p>

          <div className="plan-grid">
            {PLANS.map((plan) => (
              <PlanCard key={plan.id} plan={plan} />
            ))}
          </div>
        </div>
      </section>

      {/* open source */}
      <section style={{ background: "#fbfaf9", borderTop: "1px solid #e0e0dc", padding: "80px 24px 88px" }}>
        <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", alignItems: "center" }}>
          <div className="eyebrow" style={{ marginBottom: 18 }}>
            OPEN SOURCE
          </div>
          <h2 className="section-title" style={{ margin: 0, maxWidth: "16ch" }}>
            Built in the open
          </h2>
          <p style={{ ...sectionSub, maxWidth: "56ch" }}>
            Companion and its sync server are developed in the open. Read the code, follow the roadmap, open an issue,
            or send a pull request — and if you'd rather not run a server, a subscription keeps ours running.
          </p>
          <div style={{ marginTop: 28 }}>
            <NavButtons
              gap={12}
              links={[
                {
                  label: "Star on GitHub",
                  href: GITHUB_URL,
                  variant: "secondary",
                  size: "lg",
                  external: true,
                  onClick: () => posthog.capture("github_repo_clicked", { location: "pricing" }),
                },
                { label: "Contact us", href: "/contact", variant: "ghost", size: "lg" },
              ]}
            />
          </div>
        </div>
      </section>

      {/* faq */}
      <section style={{ background: "#ffffff", borderTop: "1px solid #e0e0dc", padding: "88px 24px 104px" }}>
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          <div className="eyebrow" style={{ marginBottom: 16 }}>
            FAQ
          </div>
          <h2 style={faqTitle}>Questions about pricing</h2>

          <div style={{ marginTop: 36 }}>
            {FAQS.map((item) => (
              <details
                key={item.q}
                className="faq-item"
                onToggle={(e) => {
                  if (e.currentTarget.open) posthog.capture("pricing_faq_opened", { question: item.q });
                }}
              >
                <summary>
                  <span>{item.q}</span>
                  <span className="faq-chevron" aria-hidden>
                    <Icon name="chevronDown" size={18} color="#a7a7a1" />
                  </span>
                </summary>
                <div className="faq-answer">{item.a}</div>
              </details>
            ))}
          </div>

          <p style={faqFooter}>
            Still wondering something? <a href="/docs">Browse the docs</a> or <a href="/contact">get in touch</a>.
          </p>
        </div>
      </section>

      <SiteFooter tone="sunken" />
    </div>
  );
}

function PlanCard({ plan }: { plan: Plan }) {
  const posthog = usePostHog();
  const track = (label: string) => posthog.capture("pricing_cta_clicked", { plan: plan.id, label });

  return (
    <article className="plan-card">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={planIcon}>
          <Icon name={plan.icon} size={19} color="#f76808" />
        </div>
        <h3 style={planName}>{plan.name}</h3>
      </div>
      <p style={planBlurb}>{plan.blurb}</p>

      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 22 }}>
        <span className="plan-price">{plan.price}</span>
        {plan.currency ? <span style={planCurrency}>{plan.currency}</span> : null}
      </div>
      <div style={planPeriod}>{plan.period}</div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, margin: "24px 0 28px" }}>
        <PlanCta cta={plan.primary} variant="primary" onClick={track} />
        <PlanCta cta={plan.secondary} variant="secondary" onClick={track} />
      </div>

      <ul className="plan-features">
        {plan.features.map((feature) => (
          <li key={feature}>
            <span aria-hidden style={{ display: "flex", flexShrink: 0, marginTop: 2 }}>
              <Icon name="check" size={16} color="#f76808" strokeWidth={2.25} />
            </span>
            <span>{feature}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

/** A card's call to action: a design-system button wrapped in a real link, full card width
 *  (the anchor is a block, so the button's flex box stretches to it). */
function PlanCta({
  cta,
  variant,
  onClick,
}: {
  cta: Plan["primary"];
  variant: "primary" | "secondary";
  onClick: (label: string) => void;
}) {
  return (
    <a
      className="plan-cta"
      href={cta.href}
      onClick={() => onClick(cta.label)}
      {...(cta.external ? { target: "_blank", rel: "noreferrer" } : {})}
    >
      <Button variant={variant} size="lg" label={cta.label} />
    </a>
  );
}

const glow: React.CSSProperties = {
  position: "absolute",
  top: "-22%",
  left: "50%",
  transform: "translateX(-50%)",
  width: 620,
  height: 620,
  borderRadius: "50%",
  background: "radial-gradient(circle, #f7680844 0%, #f768081a 42%, transparent 70%)",
  filter: "blur(10px)",
  pointerEvents: "none",
};

const heroSub: React.CSSProperties = {
  fontFamily: "'Geist', sans-serif",
  fontSize: 18,
  lineHeight: 1.6,
  color: "#6f6863",
  maxWidth: "58ch",
  textWrap: "pretty",
  margin: "26px 0 0",
};

const sectionSub: React.CSSProperties = {
  fontFamily: "'Geist', sans-serif",
  fontSize: 18,
  lineHeight: 1.55,
  color: "#595954",
  textAlign: "center",
  maxWidth: "58ch",
  textWrap: "pretty",
  margin: "18px 0 0",
};

const planIcon: React.CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 10,
  background: "#fff4ed",
  border: "1px solid #feccab",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

const planName: React.CSSProperties = {
  margin: 0,
  fontFamily: "'Geist', sans-serif",
  fontSize: 21,
  fontWeight: 600,
  letterSpacing: "-0.02em",
  color: "#1a1a18",
};

const planBlurb: React.CSSProperties = {
  margin: "14px 0 0",
  fontFamily: "'Geist', sans-serif",
  fontSize: 15.5,
  lineHeight: 1.55,
  color: "#595954",
  textWrap: "pretty",
};

const planCurrency: React.CSSProperties = {
  fontFamily: "'Geist', sans-serif",
  fontSize: 15,
  fontWeight: 500,
  color: "#a7a7a1",
};

const planPeriod: React.CSSProperties = {
  marginTop: 6,
  fontFamily: "'Geist', sans-serif",
  fontSize: 14.5,
  color: "#7b7b75",
};

const faqTitle: React.CSSProperties = {
  margin: 0,
  fontFamily: "'Geist', sans-serif",
  fontWeight: 600,
  fontSize: "clamp(30px, 5vw, 40px)",
  lineHeight: 1.1,
  letterSpacing: "-0.025em",
  color: "#1a1a18",
};

const faqFooter: React.CSSProperties = {
  margin: "36px 0 0",
  fontFamily: "'Geist', sans-serif",
  fontSize: 16,
  color: "#7b7b75",
};
