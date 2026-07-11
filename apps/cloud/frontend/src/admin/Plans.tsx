import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as api from "../api";
import { colors, styles as g } from "../theme";

// Plans admin: lists configured plans and a create flow that reads the account's Stripe
// prices and turns a chosen one into a plan. The built-in 'free' plan is always present
// and can't be removed.
export function PlansPage() {
  const [plans, setPlans] = useState<api.Plan[] | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  const load = () => api.adminPlans().then((r) => setPlans(r.plans)).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  if (error && !plans) return <Text style={[g.error, { padding: 24 }]}>{error}</Text>;
  if (!plans) return <ActivityIndicator style={{ padding: 40 }} />;

  return (
    <View style={{ gap: 16 }}>
      <View style={s.headerRow}>
        <Text style={g.h1}>Plans</Text>
        {!creating ? (
          <Pressable style={g.button} onPress={() => setCreating(true)}>
            <Text style={g.buttonText}>New plan</Text>
          </Pressable>
        ) : null}
      </View>

      {creating ? (
        <CreatePlan
          existing={plans}
          onCancel={() => setCreating(false)}
          onCreated={(next) => {
            setPlans(next);
            setCreating(false);
          }}
        />
      ) : null}

      <View style={g.card}>
        <View style={[s.row, s.head]}>
          <Text style={[s.cell, s.grow, s.th]}>Plan</Text>
          <Text style={[s.cell, s.th, s.colPrice]}>Price</Text>
          <Text style={[s.cell, s.th, s.colStripe]}>Stripe price</Text>
          <Text style={[s.cell, s.th, s.colAct]} />
        </View>
        {plans.map((p) => (
          <View key={p.id} style={s.row}>
            <View style={[s.cell, s.grow]}>
              <Text style={s.name}>{p.name}</Text>
              <Text style={s.slug}>{p.id}</Text>
            </View>
            <Text style={[s.cell, s.colPrice, s.muted]}>
              {p.stripePriceId ? priceLabel(p.amount, p.currency, p.interval) : "Free"}
            </Text>
            <Text style={[s.cell, s.colStripe, s.mono]} numberOfLines={1}>
              {p.stripePriceId || "—"}
            </Text>
            <View style={[s.cell, s.colAct]}>
              {p.id !== "free" ? (
                <Pressable onPress={() => api.adminDeletePlan(p.id).then((r) => setPlans(r.plans)).catch((e) => setError(e.message))}>
                  <Text style={s.delete}>Delete</Text>
                </Pressable>
              ) : (
                <Text style={s.builtin}>built-in</Text>
              )}
            </View>
          </View>
        ))}
      </View>
      {error ? <Text style={g.error}>{error}</Text> : null}
    </View>
  );
}

function CreatePlan(props: {
  existing: api.Plan[];
  onCancel: () => void;
  onCreated: (plans: api.Plan[]) => void;
}) {
  const [prices, setPrices] = useState<api.StripePrice[] | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<api.StripePrice | null>(null);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .adminStripePrices()
      .then((r) => setPrices(r.prices))
      .catch((e) => setError(e.message));
  }, []);

  const pick = (p: api.StripePrice) => {
    setSelected(p);
    setName(p.productName || p.nickname || "");
    setSlug(slugify(p.productName || p.nickname || p.priceId));
  };

  const create = async () => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const r = await api.adminCreatePlan({
        id: slug.trim(),
        name: name.trim(),
        stripePriceId: selected.priceId,
        amount: selected.amount,
        currency: selected.currency,
        interval: selected.interval,
      });
      props.onCreated(r.plans);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };

  const taken = new Set(props.existing.map((p) => p.stripePriceId).filter(Boolean));

  return (
    <View style={g.card}>
      <View style={s.headerRow}>
        <Text style={g.cardTitle}>New plan from Stripe</Text>
        <Pressable onPress={props.onCancel}>
          <Text style={g.link}>Cancel</Text>
        </Pressable>
      </View>

      {error ? <Text style={g.error}>{error}</Text> : null}
      {!prices ? (
        <ActivityIndicator />
      ) : prices.length === 0 ? (
        <Text style={g.subtitle}>No active recurring prices found in Stripe.</Text>
      ) : (
        <>
          <Text style={g.label}>Choose a Stripe price</Text>
          <View style={{ gap: 8 }}>
            {prices.map((p) => {
              const already = taken.has(p.priceId);
              const isSel = selected?.priceId === p.priceId;
              return (
                <Pressable
                  key={p.priceId}
                  style={[s.priceOption, isSel && s.priceOptionSel, already && { opacity: 0.5 }]}
                  onPress={() => !already && pick(p)}
                  disabled={already}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={s.name}>{p.productName || p.nickname || "Untitled"}</Text>
                    <Text style={s.mono}>{p.priceId}</Text>
                  </View>
                  <Text style={s.muted}>
                    {already ? "in use" : priceLabel(p.amount, p.currency, p.interval)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {selected ? (
            <View style={{ gap: 12, marginTop: 8 }}>
              <View>
                <Text style={g.label}>Plan name</Text>
                <TextInput style={g.input} value={name} onChangeText={setName} placeholder="Pro" />
              </View>
              <View>
                <Text style={g.label}>Slug (id)</Text>
                <TextInput style={g.input} value={slug} onChangeText={setSlug} placeholder="pro-monthly" autoCapitalize="none" />
              </View>
              <Pressable style={[g.button, { alignSelf: "flex-start" }]} onPress={create} disabled={busy || !slug.trim()}>
                <Text style={g.buttonText}>{busy ? "…" : "Create plan"}</Text>
              </Pressable>
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

function priceLabel(amount: number, currency: string, interval: string): string {
  const money = api.formatMoney(amount, currency);
  return interval ? `${money} / ${interval}` : money;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const s = StyleSheet.create({
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.border },
  head: { borderTopWidth: 0 },
  cell: { paddingRight: 8 },
  th: { fontSize: 12, fontWeight: "600", color: colors.muted, textTransform: "uppercase" },
  grow: { flex: 1, minWidth: 0 },
  colPrice: { width: 120 },
  colStripe: { width: 200 },
  colAct: { width: 70, alignItems: "flex-end" },
  name: { fontSize: 14, fontWeight: "600", color: colors.text },
  slug: { fontSize: 12, color: colors.muted },
  muted: { fontSize: 13, color: colors.muted },
  mono: { fontSize: 12, color: colors.muted, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
  delete: { fontSize: 13, color: colors.danger },
  builtin: { fontSize: 12, color: colors.muted },
  priceOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 12,
  },
  priceOptionSel: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
});
