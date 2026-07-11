import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import * as api from "../api";
import { colors, styles as g } from "../theme";
import { navigate } from "../router";

// ---- users list -----------------------------------------------------------

export function UsersList() {
  const [users, setUsers] = useState<api.AdminUser[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.adminUsers().then((r) => setUsers(r.users)).catch((e) => setError(e.message));
  }, []);

  if (error) return <Text style={[g.error, { padding: 24 }]}>{error}</Text>;
  if (!users) return <ActivityIndicator style={{ padding: 40 }} />;

  return (
    <View style={g.card}>
      <Text style={g.cardTitle}>Users ({users.length})</Text>
      <View>
        <View style={[s.row, s.head]}>
          <Text style={[s.cell, s.grow, s.th]}>Email</Text>
          <Text style={[s.cell, s.th, s.colName]}>Name</Text>
          <Text style={[s.cell, s.th, s.colStatus]}>Subscription</Text>
          <Text style={[s.cell, s.th, s.colDate]}>Joined</Text>
        </View>
        {users.map((u) => (
          <Pressable key={u.id} style={s.row} onPress={() => navigate(`/admin/users/${u.id}`)}>
            <View style={[s.cell, s.grow]}>
              <Text style={s.email}>{u.email}</Text>
              {u.isAdmin ? <Text style={s.adminTag}>admin</Text> : null}
            </View>
            <Text style={[s.cell, s.colName, s.muted]}>{fullName(u) || "—"}</Text>
            <View style={[s.cell, s.colStatus]}>
              <SubBadge status={u.subscriptionStatus} />
            </View>
            <Text style={[s.cell, s.colDate, s.muted]}>{shortDate(u.createdAt)}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// ---- user show / edit -----------------------------------------------------

export function UserDetail(props: { id: string }) {
  const [user, setUser] = useState<api.AdminUser | null>(null);
  const [sub, setSub] = useState<api.AdminSubscription | null>(null);
  const [invoices, setInvoices] = useState<api.Invoice[]>([]);
  const [error, setError] = useState("");

  // Editable fields
  const [email, setEmail] = useState("");
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [admin, setAdmin] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const apply = (u: api.AdminUser) => {
    setUser(u);
    setEmail(u.email);
    setFirst(u.firstName);
    setLast(u.lastName);
    setAdmin(u.isAdmin);
  };

  useEffect(() => {
    api
      .adminUser(props.id)
      .then((r) => {
        apply(r.user);
        setSub(r.subscription);
      })
      .catch((e) => setError(e.message));
    api.adminUserInvoices(props.id).then((r) => setInvoices(r.invoices)).catch(() => {});
  }, [props.id]);

  const [action, setAction] = useState("");
  const [note, setNote] = useState("");

  const save = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const r = await api.adminUpdateUser(props.id, { email, firstName: first, lastName: last, isAdmin: admin });
      apply(r.user);
      setSub(r.subscription);
      setSaved(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const runAction = async (name: string, fn: () => Promise<void>) => {
    setAction(name);
    setError("");
    setNote("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setAction("");
    }
  };
  const grantFree = () =>
    runAction("grant", async () => {
      const r = await api.adminGrantFree(props.id);
      apply(r.user);
      setSub(r.subscription);
      setNote("Free subscription granted.");
    });
  const revoke = () =>
    runAction("revoke", async () => {
      const r = await api.adminRevoke(props.id);
      apply(r.user);
      setSub(r.subscription);
      setNote("Subscription revoked.");
    });
  const resend = () =>
    runAction("resend", async () => {
      const r = await api.adminResendVerification(props.id);
      setNote(r.verified ? "Already verified." : "Verification email sent.");
    });

  if (error && !user) return <Text style={[g.error, { padding: 24 }]}>{error}</Text>;
  if (!user) return <ActivityIndicator style={{ padding: 40 }} />;

  const active = !!sub && (sub.status === "active" || sub.status === "trialing");
  const adminGrant = !!sub && sub.source === "admin";

  return (
    <View style={{ gap: 16 }}>
      <Pressable onPress={() => navigate("/admin/users")} style={{ alignSelf: "flex-start" }}>
        <Text style={g.link}>← All users</Text>
      </Pressable>

      <View style={g.card}>
        <Text style={g.cardTitle}>Edit user</Text>
        <Labeled label="Email">
          <TextInput style={g.input} value={email} onChangeText={setEmail} autoCapitalize="none" />
        </Labeled>
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Labeled label="First name" style={{ flex: 1 }}>
            <TextInput style={g.input} value={first} onChangeText={setFirst} />
          </Labeled>
          <Labeled label="Last name" style={{ flex: 1 }}>
            <TextInput style={g.input} value={last} onChangeText={setLast} />
          </Labeled>
        </View>
        <View style={s.switchRow}>
          <Switch value={admin} onValueChange={setAdmin} />
          <Text style={s.switchLabel}>Administrator</Text>
        </View>
        <View style={s.switchRow}>
          <Text style={s.switchLabel}>
            Email {user.emailVerified ? "verified" : "not verified"}
          </Text>
          {!user.emailVerified ? (
            <Pressable onPress={resend} disabled={action !== ""}>
              <Text style={g.link}>{action === "resend" ? "…" : "Resend verification"}</Text>
            </Pressable>
          ) : null}
        </View>
        {error ? <Text style={g.error}>{error}</Text> : null}
        {saved ? <Text style={g.success}>Saved.</Text> : null}
        <Pressable style={[g.button, { alignSelf: "flex-start" }]} onPress={save} disabled={saving}>
          <Text style={g.buttonText}>{saving ? "…" : "Save"}</Text>
        </Pressable>
      </View>

      <View style={g.card}>
        <Text style={g.cardTitle}>Subscription</Text>
        {sub ? (
          <View style={{ gap: 6 }}>
            <KV k="Plan" v={sub.plan || "—"} />
            <KV k="Source" v={sub.source} />
            <KV k="Status" v={sub.status} />
            <KV k="Renews" v={sub.currentPeriodEnd ? shortDate(sub.currentPeriodEnd) : "—"} />
            <KV k="Stripe customer" v={sub.stripeCustomerId || "—"} />
            <KV k="Stripe subscription" v={sub.stripeSubscriptionId || "—"} />
          </View>
        ) : (
          <Text style={g.subtitle}>No subscription.</Text>
        )}
        {note ? <Text style={g.success}>{note}</Text> : null}
        {active && sub?.source === "stripe" ? (
          <Text style={g.subtitle}>Active Stripe subscription — cancel it in Stripe to change.</Text>
        ) : adminGrant && active ? (
          <Pressable style={[g.buttonGhost, { alignSelf: "flex-start" }]} onPress={revoke} disabled={action !== ""}>
            <Text style={g.buttonGhostText}>{action === "revoke" ? "…" : "Revoke free subscription"}</Text>
          </Pressable>
        ) : (
          <Pressable style={[g.button, { alignSelf: "flex-start" }]} onPress={grantFree} disabled={action !== ""}>
            <Text style={g.buttonText}>{action === "grant" ? "…" : "Grant free subscription"}</Text>
          </Pressable>
        )}
      </View>

      <View style={g.card}>
        <Text style={g.cardTitle}>Invoices</Text>
        {invoices.length === 0 ? (
          <Text style={g.subtitle}>No invoices.</Text>
        ) : (
          invoices.map((inv, i) => (
            <View key={inv.number || i} style={[s.invoiceRow, i > 0 && s.divider]}>
              <Text style={s.invoiceAmount}>{api.formatMoney(inv.amount, inv.currency)}</Text>
              <Text style={[g.subtitle, { flex: 1, textAlign: "right" }]}>
                {shortDate(new Date(inv.created * 1000).toISOString())} · {inv.status}
              </Text>
            </View>
          ))
        )}
      </View>
    </View>
  );
}

// ---- shared bits ----------------------------------------------------------

export function SubBadge(props: { status: string }) {
  const active = props.status === "active" || props.status === "trialing";
  return (
    <View style={[g.badge, { backgroundColor: active ? colors.successSoft : "#f3f3f0" }]}>
      <Text style={[g.badgeText, { color: active ? colors.success : colors.muted }]}>{props.status}</Text>
    </View>
  );
}

function Labeled(props: { label: string; children: React.ReactNode; style?: any }) {
  return (
    <View style={props.style}>
      <Text style={g.label}>{props.label}</Text>
      {props.children}
    </View>
  );
}

function KV(props: { k: string; v: string }) {
  return (
    <View style={s.kv}>
      <Text style={s.kvKey}>{props.k}</Text>
      <Text style={s.kvVal}>{props.v}</Text>
    </View>
  );
}

export function fullName(u: { firstName: string; lastName: string }): string {
  return `${u.firstName} ${u.lastName}`.trim();
}

export function shortDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border },
  head: { borderTopWidth: 0 },
  cell: { paddingRight: 8 },
  th: { fontSize: 12, fontWeight: "600", color: colors.muted, textTransform: "uppercase" },
  grow: { flex: 1, minWidth: 0 },
  colName: { width: 140 },
  colStatus: { width: 110 },
  colDate: { width: 90 },
  email: { fontSize: 14, color: colors.text },
  adminTag: { fontSize: 11, color: colors.accent, fontWeight: "600" },
  muted: { fontSize: 13, color: colors.muted },

  switchRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  switchLabel: { fontSize: 14, color: colors.text },

  kv: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  kvKey: { fontSize: 13, color: colors.muted },
  kvVal: { fontSize: 13, color: colors.text, fontWeight: "500" },

  invoiceRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10 },
  divider: { borderTopWidth: 1, borderTopColor: colors.border },
  invoiceAmount: { fontSize: 14, fontWeight: "600", color: colors.text },
});
