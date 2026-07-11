import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { BrandMark } from "@companion/design-system";
import { colors, styles as g } from "../theme";
import { navigate, usePath } from "../router";
import Dashboard from "./Dashboard";
import { UsersList, UserDetail } from "./Users";
import { SubscriptionsList } from "./Subscriptions";
import { PlansPage } from "./Plans";

// Admin interface: a top toolbar of links over path-routed pages (/admin, /admin/users,
// /admin/users/:id, /admin/subscriptions). Rendered only for admins (gated in App).
export default function AdminApp(props: { onExitAdmin: () => void; onSignOut: () => void }) {
  const path = usePath();
  return (
    <View style={g.screen}>
      <AdminToolbar path={path} onExitAdmin={props.onExitAdmin} onSignOut={props.onSignOut} />
      <ScrollView contentContainerStyle={s.content}>
        <View style={s.page}>
          <Page path={path} />
        </View>
      </ScrollView>
    </View>
  );
}

function Page(props: { path: string }) {
  const p = props.path.replace(/\/$/, "");
  if (p === "/admin/users") return <UsersList />;
  if (p.startsWith("/admin/users/")) return <UserDetail id={decodeURIComponent(p.slice("/admin/users/".length))} />;
  if (p === "/admin/subscriptions") return <SubscriptionsList />;
  if (p === "/admin/plans") return <PlansPage />;
  return <Dashboard />;
}

const LINKS: { label: string; path: string }[] = [
  { label: "Dashboard", path: "/admin" },
  { label: "Users", path: "/admin/users" },
  { label: "Subscriptions", path: "/admin/subscriptions" },
  { label: "Plans", path: "/admin/plans" },
];

function AdminToolbar(props: { path: string; onExitAdmin: () => void; onSignOut: () => void }) {
  const active = (link: { path: string }) =>
    link.path === "/admin" ? props.path.replace(/\/$/, "") === "/admin" : props.path.startsWith(link.path);
  return (
    <View style={s.bar}>
      <View style={s.left}>
        <BrandMark size={24} />
        <Text style={s.brand}>Companion Cloud</Text>
        <Text style={s.adminTag}>Admin</Text>
        <View style={s.nav}>
          {LINKS.map((link) => (
            <Pressable key={link.path} onPress={() => navigate(link.path)}>
              <Text style={[s.navLink, active(link) && s.navLinkActive]}>{link.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <View style={s.right}>
        <Pressable onPress={props.onExitAdmin}>
          <Text style={s.navLink}>Exit admin</Text>
        </Pressable>
        <Pressable onPress={props.onSignOut}>
          <Text style={[s.navLink, { color: colors.danger }]}>Sign out</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  bar: {
    height: 60,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 24,
    backgroundColor: colors.toolbar,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  left: { flexDirection: "row", alignItems: "center", gap: 12 },
  brand: { fontSize: 16, fontWeight: "700", color: colors.text },
  adminTag: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
    color: colors.accent,
    backgroundColor: colors.accentSoft,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 5,
    textTransform: "uppercase",
    overflow: "hidden",
  },
  nav: { flexDirection: "row", alignItems: "center", gap: 22, marginLeft: 20 },
  right: { flexDirection: "row", alignItems: "center", gap: 20 },
  navLink: { fontSize: 14, color: colors.muted, fontWeight: "500" },
  navLinkActive: { color: colors.text, fontWeight: "600" },

  content: { paddingHorizontal: 20, paddingVertical: 28 },
  page: { width: 820, maxWidth: "100%", alignSelf: "center" },
});
