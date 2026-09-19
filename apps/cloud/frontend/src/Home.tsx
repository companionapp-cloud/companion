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

// Where a subscriber gets Companion itself: the docs page covering every platform, and the web
// app for anyone who'd rather not install anything.
const APPS_URL = "https://companionapp.cloud/docs/getting-the-apps";
const WEB_APP_URL = "https://web.companionapp.cloud";

export default function Home(props: {
  sub: api.Subscription | null;
  email: string;
  onError: (m: string) => void;
  onSubscriptionChange: (sub: api.Subscription) => void;
}) {
  const active = props.sub?.status === "active" || props.sub?.status === "trialing";

  return (
    <View style={s.container}>
      <SubscriptionCard
        sub={props.sub}
        active={active}
        onError={props.onError}
        onChanged={props.onSubscriptionChange}
      />
      <FeaturesCard active={active} />
      {active ? <StartSyncingCard email={props.email} /> : null}
      {active ? <UpcomingCard /> : null}
      {active ? <InvoicesCard /> : null}
    </View>
  );
}

// Where a subscriber picks Companion up. The apps have Companion Cloud built into their sign-in,
// so there's no server address to copy across — this account's email and password are the whole
// setup, on the desktop app or on the web.
function StartSyncingCard(props: { email: string }) {
  return (
    <View style={g.card}>
      <Text style={g.cardTitle}>Start syncing</Text>
      <Text style={g.subtitle}>
        In Companion, open Settings → Sync and choose Sign in, then log in to Companion Cloud with
        this account{props.email ? ` (${props.email})` : ""}. Every device you sign in on stays in step.
      </Text>
      <SyncOption
        title="On your computer"
        detail="Install the desktop app, then sign in from its settings."
        action="Get the apps"
        url={APPS_URL}
      />
      <SyncOption
        title="In your browser"
        detail="Nothing to install — open Companion on the web and sign in."
        action="Open the web app"
        url={WEB_APP_URL}
      />
    </View>
  );
}

function SyncOption(props: { title: string; detail: string; action: string; url: string }) {
  return (
    <View style={s.option}>
      <View style={{ gap: 2 }}>
        <Text style={s.optionTitle}>{props.title}</Text>
        <Text style={g.subtitle}>{props.detail}</Text>
      </View>
      <Pressable style={[g.buttonGhost, s.optionBtn]} onPress={() => Linking.openURL(props.url)}>
        <Text style={g.buttonGhostText}>{props.action}</Text>
      </Pressable>
    </View>
  );
}

// The subscription, and the two things a user can do to it: start one, or stop it renewing.
// Cancelling takes effect at the end of the period already paid for — sync keeps working until
// then — so it stays undoable right up to that date.
function SubscriptionCard(props: {
  sub: api.Subscription | null;
  active: boolean;
  onError: (m: string) => void;
  onChanged: (sub: api.Subscription) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const status = props.sub?.status ?? "none";
  const ending = props.active && props.sub?.cancelAtPeriodEnd === true;
  const endsOn = props.sub?.currentPeriodEnd
    ? new Date(props.sub.currentPeriodEnd).toLocaleDateString()
    : "";

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

  const change = async (fn: () => Promise<api.Subscription>) => {
    setBusy(true);
    props.onError("");
    try {
      props.onChanged(await fn());
      setConfirming(false);
    } catch (e: any) {
      props.onError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={g.card}>
      <View style={s.rowBetween}>
        <Text style={g.cardTitle}>Subscription</Text>
        <View
          style={[
            g.badge,
            { backgroundColor: props.active && !ending ? colors.successSoft : "#f3f3f0" },
          ]}
        >
          <Text style={[g.badgeText, { color: props.active && !ending ? colors.success : colors.text }]}>
            {ending ? "ending" : status}
          </Text>
        </View>
      </View>

      {!props.active ? (
        <>
          <Text style={g.subtitle}>Subscribe to unlock sync and everything below.</Text>
          <Pressable style={g.button} onPress={subscribe} disabled={busy}>
            <Text style={g.buttonText}>{busy ? "…" : "Subscribe"}</Text>
          </Pressable>
        </>
      ) : ending ? (
        <>
          <Text style={g.subtitle}>
            {endsOn
              ? `Your subscription ends on ${endsOn}.`
              : "Your subscription ends when the current period does."}{" "}
            Sync keeps working until then — resume before that and nothing changes.
          </Text>
          <Pressable style={g.buttonGhost} onPress={() => change(api.resumeSubscription)} disabled={busy}>
            <Text style={g.buttonGhostText}>{busy ? "…" : "Resume subscription"}</Text>
          </Pressable>
        </>
      ) : confirming ? (
        <>
          <Text style={g.subtitle}>
            Cancel your subscription? Sync keeps working until{" "}
            {endsOn || "the end of the period you've paid for"}, and you can resume any time before
            then. Your notes stay on your devices either way — they just stop syncing between them.
          </Text>
          <View style={s.confirmRow}>
            <Pressable style={[g.buttonGhost, s.grow]} onPress={() => setConfirming(false)} disabled={busy}>
              <Text style={g.buttonGhostText}>Keep it</Text>
            </Pressable>
            <Pressable style={[s.dangerBtn, s.grow]} onPress={() => change(api.cancelSubscription)} disabled={busy}>
              <Text style={s.dangerBtnText}>{busy ? "…" : "Cancel subscription"}</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <>
          <Text style={g.subtitle}>
            Sync is enabled across all your devices.{endsOn ? ` Renews ${endsOn}.` : ""}
          </Text>
          {props.sub?.cancelable ? (
            <Pressable style={s.cancelLink} onPress={() => setConfirming(true)}>
              <Text style={s.cancelLinkText}>Cancel subscription</Text>
            </Pressable>
          ) : null}
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

  // "Start syncing": one bordered tile per way of getting the app.
  option: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 16, gap: 12 },
  optionTitle: { fontSize: 15, fontWeight: "600", color: colors.text },
  optionBtn: { alignSelf: "flex-start" },

  // Cancelling: a quiet link, then a two-button confirmation in its place.
  cancelLink: { alignSelf: "flex-start", paddingVertical: 4 },
  cancelLinkText: { fontSize: 13, color: colors.muted, textDecorationLine: "underline" },
  confirmRow: { flexDirection: "row", gap: 10 },
  grow: { flex: 1 },
  dangerBtn: {
    borderRadius: 8,
    paddingVertical: 11,
    paddingHorizontal: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.danger,
  },
  dangerBtnText: { color: colors.danger, fontSize: 15, fontWeight: "600" },

  invoiceRow: { flexDirection: "row", alignItems: "center", paddingVertical: 12 },
  invoiceDivider: { borderTopWidth: 1, borderTopColor: colors.border },
  invoiceAmount: { fontSize: 15, fontWeight: "600", color: colors.text },
});
