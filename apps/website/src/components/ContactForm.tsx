import { Icon, type IconName } from "@companion/design-system";
import { useRef, useState, type CSSProperties, type FormEvent } from "react";
import { usePostHog } from "posthog-js/react";

// Contact form (ported from Contact.dc.html's page logic). On submit it opens a PostHog
// support conversation when that feature is available, and always confirms to the user.

type RequestType = "help" | "feature" | "other";

// posthog-js support-conversations API (not yet in the shipped SDK types).
interface Conversations {
  isAvailable: () => boolean;
  sendMessage: (
    message: string,
    opts: { name?: string; email?: string },
  ) => Promise<{ ticket_id?: string } | undefined>;
}

const TYPES: { key: RequestType; icon: IconName; label: string }[] = [
  { key: "help", icon: "chat", label: "I need help" },
  { key: "feature", icon: "plus", label: "Request a feature" },
  { key: "other", icon: "notes", label: "Something else" },
];

const typeBase: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "13px 16px",
  borderRadius: 12,
  cursor: "pointer",
  flex: "1 1 150px",
  userSelect: "none",
  fontFamily: "'Geist', sans-serif",
  transition: "all .15s ease",
};

const labelStyle: CSSProperties = {
  fontFamily: "'Geist', sans-serif",
  fontSize: 14,
  fontWeight: 600,
  color: "#1a1a18",
};

export function ContactForm() {
  const posthog = usePostHog();
  const [type, setType] = useState<RequestType>("help");
  const [sent, setSent] = useState(false);
  const [sentTo, setSentTo] = useState("");
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  const handleTypeChange = (t: RequestType) => {
    setType(t);
    posthog.capture("contact_type_selected", { request_type: t });
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const subject = (subjectRef.current?.value ?? "").trim();
    const email = (emailRef.current?.value ?? "").trim();
    const message = (messageRef.current?.value ?? "").trim();

    posthog.capture("contact_form_submitted", { request_type: type, email });

    // Open a PostHog support conversation when the feature is available. If the send
    // fails, surface an error and keep the user on the form so they can retry.
    const conversations = (posthog as unknown as { conversations?: Conversations }).conversations;
    if (conversations?.isAvailable()) {
      setSending(true);
      const label = TYPES.find((t) => t.key === type)?.label ?? "Contact";
      const body = [`[${label}]`, subject ? `Subject: ${subject}` : "", "", message].filter(Boolean).join("\n");
      try {
        const response = await conversations.sendMessage(body, { email });
        setTicketId(response?.ticket_id ?? null);
      } catch {
        posthog.capture("contact_form_error", { request_type: type });
        setError(
          "Something went wrong sending your message. Please try again, or email us directly at support@companion.app.",
        );
        setSending(false);
        return;
      }
      setSending(false);
    }

    setSent(true);
    setSentTo(email ? ` — we'll reply to ${email}` : "");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (sent) {
    return (
      <div
        style={{
          marginTop: 36,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          gap: 16,
          padding: "48px 32px",
          background: "#f5f5f3",
          border: "1px solid #e0e0dc",
          borderRadius: 20,
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 999,
            background: "#f76808",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
            <path d="m5 13 4 4L19 7" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div style={{ fontFamily: "'Geist', sans-serif", fontSize: 24, fontWeight: 600, color: "#1a1a18" }}>
          Message sent
        </div>
        <div style={{ fontFamily: "'Geist', sans-serif", fontSize: 16, lineHeight: 1.55, color: "#595954", maxWidth: "38ch" }}>
          Thanks for reaching out{sentTo}. We'll get back to you soon.
        </div>
        {ticketId ? (
          <div style={{ fontFamily: "'Geist Mono', monospace", fontSize: 13, color: "#a7a7a1" }}>
            Ticket #{ticketId}
          </div>
        ) : null}
        <div style={{ marginTop: 6 }}>
          <button
            onClick={() => {
              setSent(false);
              setSentTo("");
              setTicketId(null);
            }}
            style={{
              fontFamily: "'Geist', sans-serif",
              fontSize: 14,
              fontWeight: 600,
              color: "#3e3e3a",
              background: "#fff",
              border: "1px solid #cececa",
              borderRadius: 10,
              padding: "10px 20px",
              cursor: "pointer",
            }}
          >
            Send another
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} style={{ marginTop: 36, display: "flex", flexDirection: "column", gap: 26 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label style={labelStyle}>What can we help with?</label>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {TYPES.map((t) => {
            const selected = type === t.key;
            return (
              <div
                key={t.key}
                className="rtype"
                onClick={() => handleTypeChange(t.key)}
                style={{
                  ...typeBase,
                  border: `1px solid ${selected ? "#f76808" : "#cececa"}`,
                  background: selected ? "#fff4ed" : "#ffffff",
                  color: selected ? "#b83a05" : "#3e3e3a",
                }}
              >
                <Icon name={t.icon} size={18} color={selected ? "#f76808" : "#a7a7a1"} />
                <span style={{ fontFamily: "'Geist', sans-serif", fontSize: 14, fontWeight: 500 }}>{t.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <label htmlFor="subject" style={labelStyle}>
          Subject
        </label>
        <input id="subject" name="subject" ref={subjectRef} className="field" placeholder="A short summary" />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <label htmlFor="email" style={labelStyle}>
          Email address
        </label>
        <input id="email" name="email" type="email" ref={emailRef} className="field" placeholder="you@example.com" />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <label htmlFor="message" style={labelStyle}>
          Your message
        </label>
        <textarea id="message" name="message" ref={messageRef} className="field" placeholder="Tell us what's on your mind…" />
        <div style={{ fontFamily: "'Geist', sans-serif", fontSize: 13.5, color: "#7b7b75", marginTop: 2 }}>
          If you want to attach some files,{" "}
          <a href="mailto:support@companionapp.cloud" style={{ fontWeight: 600 }}>
            email us directly
          </a>
          .
        </div>
      </div>

      {error ? (
        <div
          role="alert"
          style={{
            display: "flex",
            gap: 12,
            alignItems: "flex-start",
            padding: "14px 16px",
            background: "#fbecec",
            border: "1px solid #f2c9c9",
            borderRadius: 12,
            fontFamily: "'Geist', sans-serif",
            fontSize: 14.5,
            lineHeight: 1.5,
            color: "#a12a2a",
          }}
        >
          <div style={{ flexShrink: 0, marginTop: 1 }}>
            <Icon name="close" size={18} color="#d64545" />
          </div>
          <div>{error}</div>
        </div>
      ) : null}

      <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 2, flexWrap: "wrap" }}>
        <button
          type="submit"
          disabled={sending}
          style={{
            fontFamily: "'Geist', sans-serif",
            fontSize: 15,
            fontWeight: 600,
            color: "#fff",
            background: "#f76808",
            border: "none",
            borderRadius: 10,
            padding: "13px 26px",
            cursor: sending ? "default" : "pointer",
            opacity: sending ? 0.65 : 1,
            transition: "background .15s ease",
          }}
          onMouseOver={(e) => {
            if (!sending) e.currentTarget.style.background = "#e04e02";
          }}
          onMouseOut={(e) => {
            if (!sending) e.currentTarget.style.background = "#f76808";
          }}
        >
          {sending ? "Sending…" : "Send message"}
        </button>
        <span style={{ fontFamily: "'Geist', sans-serif", fontSize: 13.5, color: "#a7a7a1" }}>
          We usually reply within a day or two.
        </span>
      </div>
    </form>
  );
}
