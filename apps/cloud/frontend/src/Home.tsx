import { useEffect, useState } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import * as api from "./api";
import { colors, styles as g } from "./theme";

// Features unlocked by an active subscription. Static content — the checkmarks light up
// when the user is subscribed.
const FEATURES: { title: string; detail: string }[] = [
  { title: "Real-time sync across devices", detail: "Web, macOS, Windows, iOS & Android stay in lockstep." },
  { title: "Unlimited notes, tasks & projects", detail: "No caps on what you capture or organize." },
  { title: "Document & file attachments", detail: "Embed files in notes, stored and synced securely." },
  { title: "Calendar feed subscriptions", detail: "Pull ICS calendars in alongside your tasks." },
  { title: "Repeating tasks & reminders", detail: "Recurring schedules and push reminders everywhere." },
];

export default function Home(props: { sub: api.Subscription | null; email: string; onError: (m: string) => void }) {
  const active = props.sub?.status === "active" || props.sub?.status === "trialing";
  const [busy, setBusy] = useState(false);

  const subscribe = async () => {
    setBusy(true);
    props.onError("");
    try {
      const { url } = await api.startCheckout();
      window.location.href = url;
    } catch (e: any) {
      props.onError(e.message);
      setBusy(false);
    }
  };

  return (
    <View style={s.container}>
      <SubscriptionCard sub={props.sub} active={active} busy={busy} onSubscribe={subscribe} />
      <FeaturesCard active={active} />
      {active ? <SyncSetupCard email={props.email} /> : null}
      {active ? <UpcomingCard /> : null}
      {active ? <InvoicesCard /> : null}
    </View>
  );
}

// SyncSetupCard tells a subscribed user how to connect the Companion app: the sync URL
// (from the server's runtime config) plus their account email.
function SyncSetupCard(props: { email: string }) {
  const [syncUrl, setSyncUrl] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.getConfig().then((c) => setSyncUrl(c.syncUrl)).catch(() => {});
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(syncUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked; the URL is still selectable on screen
    }
  };

  return (
    <View style={g.card}>
      <Text style={g.cardTitle}>Set up sync</Text>
      <Text style={g.subtitle}>
        In the Companion app, open Settings → Sync, enter the server URL below, and sign in
        with your account{props.email ? ` (${props.email})` : ""}.
      </Text>
      <Text style={g.label}>Server URL</Text>
      <View style={s.urlRow}>
        <Text style={s.url} numberOfLines={1} selectable>
          {syncUrl || "…"}
        </Text>
        <Pressable style={s.copyBtn} onPress={copy} disabled={!syncUrl}>
          <Text style={s.copyText}>{copied ? "Copied" : "Copy"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function SubscriptionCard(props: {
  sub: api.Subscription | null;
  active: boolean;
  busy: boolean;
  onSubscribe: () => void;
}) {
  const status = props.sub?.status ?? "none";
  return (
    <View style={g.card}>
      <View style={s.rowBetween}>
        <Text style={g.cardTitle}>Subscription</Text>
        <View
          style={[
            g.badge,
            { backgroundColor: props.active ? colors.successSoft : "#f3f3f0" },
          ]}
        >
          <Text style={[g.badgeText, { color: props.active ? colors.success : colors.text }]}>
            {status}
          </Text>
        </View>
      </View>
      {props.active ? (
        <Text style={g.subtitle}>
          Sync is enabled across all your devices.
          {props.sub?.currentPeriodEnd
            ? ` Renews ${new Date(props.sub.currentPeriodEnd).toLocaleDateString()}.`
            : ""}
        </Text>
      ) : (
        <>
          <Text style={g.subtitle}>Subscribe to unlock sync and everything below.</Text>
          <Pressable style={g.button} onPress={props.onSubscribe} disabled={props.busy}>
            <Text style={g.buttonText}>{props.busy ? "…" : "Subscribe"}</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

function FeaturesCard(props: { active: boolean }) {
  return (
    <View style={g.card}>
      <Text style={g.cardTitle}>What you get</Text>
      <View style={{ gap: 12 }}>
        {FEATURES.map((f) => (
          <View key={f.title} style={s.feature}>
            <View style={[s.check, props.active ? s.checkOn : s.checkOff]}>
              <Text style={[s.checkMark, { color: props.active ? "#fff" : colors.muted }]}>✓</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[s.featureTitle, !props.active && { color: colors.muted }]}>
                {f.title}
              </Text>
              <Text style={g.subtitle}>{f.detail}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

function UpcomingCard() {
  const [state, setState] = useState<"loading" | "none" | "ready">("loading");
  const [up, setUp] = useState<api.Upcoming>(null);

  useEffect(() => {
    api
      .getUpcoming()
      .then((r) => {
        setUp(r.upcoming);
        setState(r.upcoming ? "ready" : "none");
      })
      .catch(() => setState("none"));
  }, []);

  if (state === "none") return null;
  return (
    <View style={g.card}>
      <Text style={g.cardTitle}>Upcoming charge</Text>
      {state === "loading" || !up ? (
        <ActivityIndicator />
      ) : (
        <View style={s.rowBetween}>
          <Text style={s.bigAmount}>{api.formatMoney(up.amount, up.currency)}</Text>
          <Text style={g.subtitle}>
            due {new Date(up.dueAt * 1000).toLocaleDateString()}
          </Text>
        </View>
      )}
    </View>
  );
}

function InvoicesCard() {
  const [state, setState] = useState<"loading" | "empty" | "ready">("loading");
  const [invoices, setInvoices] = useState<api.Invoice[]>([]);

  useEffect(() => {
    api
      .getInvoices()
      .then((r) => {
        setInvoices(r.invoices);
        setState(r.invoices.length ? "ready" : "empty");
      })
      .catch(() => setState("empty"));
  }, []);

  return (
    <View style={g.card}>
      <Text style={g.cardTitle}>Invoices</Text>
      {state === "loading" ? (
        <ActivityIndicator />
      ) : state === "empty" ? (
        <Text style={g.subtitle}>No invoices yet.</Text>
      ) : (
        <View>
          {invoices.map((inv, i) => (
            <View key={inv.number || i} style={[s.invoiceRow, i > 0 && s.invoiceDivider]}>
              <View style={{ flex: 1 }}>
                <Text style={s.invoiceAmount}>{api.formatMoney(inv.amount, inv.currency)}</Text>
                <Text style={g.subtitle}>
                  {new Date(inv.created * 1000).toLocaleDateString()} · {inv.status}
                </Text>
              </View>
              {inv.url ? (
                <Pressable onPress={() => Linking.openURL(inv.url)}>
                  <Text style={g.link}>View</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { width: 520, maxWidth: "100%", gap: 16, paddingVertical: 32, alignSelf: "center" },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },

  feature: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  check: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  checkOn: { backgroundColor: colors.success },
  checkOff: { backgroundColor: "#f0f0ec", borderWidth: 1, borderColor: colors.border },
  checkMark: { fontSize: 13, fontWeight: "700", lineHeight: 16 },
  featureTitle: { fontSize: 15, fontWeight: "600", color: colors.text },

  bigAmount: { fontSize: 24, fontWeight: "700", color: colors.text },

  urlRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.bg,
  },
  url: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.text,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  copyBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
  },
  copyText: { fontSize: 14, fontWeight: "600", color: colors.accent },

  invoiceRow: { flexDirection: "row", alignItems: "center", paddingVertical: 12 },
  invoiceDivider: { borderTopWidth: 1, borderTopColor: colors.border },
  invoiceAmount: { fontSize: 15, fontWeight: "600", color: colors.text },
});
