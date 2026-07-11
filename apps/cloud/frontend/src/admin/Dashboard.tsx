import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import * as api from "../api";
import { colors, styles as g } from "../theme";

// Admin dashboard: user + subscription counts by period, and a live Stripe integration
// health check.
export default function Dashboard() {
  const [data, setData] = useState<api.Dashboard | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.adminDashboard().then(setData).catch((e) => setError(e.message));
  }, []);

  if (error) return <Text style={[g.error, { padding: 24 }]}>{error}</Text>;
  if (!data) return <ActivityIndicator style={{ padding: 40 }} />;

  return (
    <View style={{ gap: 16 }}>
      <PeriodGroup title="Users" counts={data.users} />
      <PeriodGroup title="Active subscriptions" counts={data.subscriptions} />
      <StripeCard stripe={data.stripe} />
    </View>
  );
}

function PeriodGroup(props: { title: string; counts: api.PeriodCounts }) {
  const tiles: { label: string; value: number }[] = [
    { label: "Today", value: props.counts.today },
    { label: "This week", value: props.counts.week },
    { label: "This month", value: props.counts.month },
    { label: "All time", value: props.counts.all },
  ];
  return (
    <View style={g.card}>
      <Text style={g.cardTitle}>{props.title}</Text>
      <View style={s.tiles}>
        {tiles.map((t) => (
          <View key={t.label} style={s.tile}>
            <Text style={s.tileValue}>{t.value.toLocaleString()}</Text>
            <Text style={s.tileLabel}>{t.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function StripeCard(props: { stripe: api.StripeStatus }) {
  const st = props.stripe;
  const healthy = st.apiKeyConfigured && st.apiReachable && st.webhookConfigured;
  return (
    <View style={g.card}>
      <View style={s.rowBetween}>
        <Text style={g.cardTitle}>Stripe integration</Text>
        <View style={[g.badge, { backgroundColor: healthy ? colors.successSoft : "#fdeceb" }]}>
          <Text style={[g.badgeText, { color: healthy ? colors.success : colors.danger }]}>
            {healthy ? "healthy" : "attention"}
          </Text>
        </View>
      </View>
      <StatusRow ok={st.apiKeyConfigured} label="API key configured" />
      <StatusRow ok={st.apiReachable} label="API reachable" />
      <StatusRow ok={st.webhookConfigured} label="Webhook secret configured" />
      <StatusRow
        ok={!!st.lastWebhookAt}
        label={
          st.lastWebhookAt
            ? `Last webhook ${new Date(st.lastWebhookAt).toLocaleString()}`
            : "No webhook received yet"
        }
      />
    </View>
  );
}

function StatusRow(props: { ok: boolean; label: string }) {
  return (
    <View style={s.statusRow}>
      <View style={[s.dot, { backgroundColor: props.ok ? colors.success : colors.danger }]} />
      <Text style={s.statusLabel}>{props.label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  tile: {
    flexGrow: 1,
    flexBasis: 120,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: 16,
    paddingHorizontal: 14,
    backgroundColor: colors.bg,
  },
  tileValue: { fontSize: 28, fontWeight: "700", color: colors.text },
  tileLabel: { fontSize: 12, color: colors.muted, marginTop: 2 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  statusLabel: { fontSize: 14, color: colors.text },
});
