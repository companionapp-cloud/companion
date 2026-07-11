import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import * as api from "../api";
import { colors, styles as g } from "../theme";
import { navigate } from "../router";
import { SubBadge, shortDate } from "./Users";

// Subscriptions list: each row links through to the owning user (where invoices live).
export function SubscriptionsList() {
  const [subs, setSubs] = useState<api.AdminSubscription[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.adminSubscriptions().then((r) => setSubs(r.subscriptions)).catch((e) => setError(e.message));
  }, []);

  if (error) return <Text style={[g.error, { padding: 24 }]}>{error}</Text>;
  if (!subs) return <ActivityIndicator style={{ padding: 40 }} />;

  return (
    <View style={g.card}>
      <Text style={g.cardTitle}>Subscriptions ({subs.length})</Text>
      {subs.length === 0 ? (
        <Text style={g.subtitle}>No subscriptions yet.</Text>
      ) : (
        <View>
          <View style={[s.row, s.head]}>
            <Text style={[s.cell, s.grow, s.th]}>User</Text>
            <Text style={[s.cell, s.th, s.colStatus]}>Status</Text>
            <Text style={[s.cell, s.th, s.colDate]}>Renews</Text>
            <Text style={[s.cell, s.th, s.colDate]}>Started</Text>
          </View>
          {subs.map((sub) => (
            <Pressable key={sub.userId} style={s.row} onPress={() => navigate(`/admin/users/${sub.userId}`)}>
              <Text style={[s.cell, s.grow, s.link]}>{sub.email}</Text>
              <View style={[s.cell, s.colStatus]}>
                <SubBadge status={sub.status} />
              </View>
              <Text style={[s.cell, s.colDate, s.muted]}>
                {sub.currentPeriodEnd ? shortDate(sub.currentPeriodEnd) : "—"}
              </Text>
              <Text style={[s.cell, s.colDate, s.muted]}>{shortDate(sub.createdAt)}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border },
  head: { borderTopWidth: 0 },
  cell: { paddingRight: 8 },
  th: { fontSize: 12, fontWeight: "600", color: colors.muted, textTransform: "uppercase" },
  grow: { flex: 1, minWidth: 0 },
  colStatus: { width: 110 },
  colDate: { width: 90 },
  link: { fontSize: 14, color: colors.accent },
  muted: { fontSize: 13, color: colors.muted },
});
