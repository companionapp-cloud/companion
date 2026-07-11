import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import * as api from "./api";
import { styles as g } from "./theme";
import { navigate, usePath } from "./router";
import Auth from "./Auth";
import Toolbar from "./Toolbar";
import Home from "./Home";
import Settings from "./Settings";
import VerifyScreen from "./VerifyScreen";
import ResetScreen from "./ResetScreen";
import AdminApp from "./admin/AdminApp";

type Screen = "loading" | "auth" | "app";
type View_ = "home" | "settings";

// Root of the cloud portal: an auth gate, then either the account area (subscription +
// settings) or, for admins on an /admin URL, the admin interface.
export default function App() {
  const path = usePath();
  const [screen, setScreen] = useState<Screen>("loading");
  const [view, setView] = useState<View_>("home");
  const [account, setAccount] = useState<api.Account | null>(null);
  const [sub, setSub] = useState<api.Subscription | null>(null);
  const [admin, setAdmin] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const [acct, subscription, isAdmin] = await Promise.all([
        api.getAccount(),
        api.getSubscription(),
        api.isAdmin(),
      ]);
      setAccount(acct);
      setSub(subscription);
      setAdmin(isAdmin);
      setScreen("app");
    } catch {
      api.setToken(null);
      setScreen("auth");
    }
  };

  useEffect(() => {
    // The reset screen (/reset?token=…) is self-contained; skip the normal auth flow.
    if (window.location.pathname === "/reset") return;
    // Verification deep link (/verify?token=…): confirm the token, strip it, then continue.
    const token =
      window.location.pathname === "/verify"
        ? new URLSearchParams(location.search).get("token")
        : null;
    if (token) {
      api
        .verifyEmail(token)
        .catch(() => {})
        .finally(() => {
          navigate("/");
          if (api.getToken()) load();
          else setScreen("auth");
        });
      return;
    }
    if (api.getToken()) load();
    else setScreen("auth");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Returning from Stripe Checkout: reload so a completed subscription is reflected.
  useEffect(() => {
    if (new URLSearchParams(location.search).get("checkout") && api.getToken()) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Guard the admin URL: a non-admin who lands on /admin is bounced to the portal.
  useEffect(() => {
    if (screen === "app" && !admin && path.startsWith("/admin")) navigate("/");
  }, [screen, admin, path]);

  const signOut = () => {
    api.setToken(null);
    setAccount(null);
    setSub(null);
    setAdmin(false);
    setView("home");
    navigate("/");
    setScreen("auth");
  };

  // Password reset (/reset?token=…) is public and self-contained — show it regardless of
  // auth state, then send the user to sign in.
  if (path === "/reset") {
    const token = new URLSearchParams(window.location.search).get("token") || "";
    return (
      <View style={g.screen}>
        <ResetScreen
          token={token}
          onDone={() => {
            navigate("/");
            setScreen("auth");
          }}
        />
      </View>
    );
  }

  if (screen === "loading") {
    return (
      <View style={g.center}>
        <ActivityIndicator />
      </View>
    );
  }

  if (screen === "auth") {
    return (
      <View style={g.screen}>
        <Auth
          onAuthed={() => {
            setScreen("loading");
            load();
          }}
        />
      </View>
    );
  }

  // Mandatory gate: an unverified user can't reach the portal or admin until confirmed.
  if (account && !account.emailVerified) {
    return (
      <View style={g.screen}>
        <VerifyScreen email={account.email} onVerified={load} onSignOut={signOut} />
      </View>
    );
  }

  if (admin && path.startsWith("/admin")) {
    return <AdminApp onExitAdmin={() => navigate("/")} onSignOut={signOut} />;
  }

  return (
    <View style={g.screen}>
      <Toolbar
        account={account}
        isAdmin={admin}
        onOpenAdmin={() => navigate("/admin")}
        onOpenSettings={() => setView("settings")}
        onSignOut={signOut}
      />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20 }} style={{ flex: 1 }}>
        {error ? (
          <Text style={[g.error, { textAlign: "center", paddingTop: 12 }]}>{error}</Text>
        ) : null}
        {view === "settings" && account ? (
          <Settings account={account} onBack={() => setView("home")} onAccountChanged={setAccount} />
        ) : (
          <Home sub={sub} email={account?.email ?? ""} onError={setError} />
        )}
      </ScrollView>
    </View>
  );
}
