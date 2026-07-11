import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import * as api from "./api";
import { styles as g } from "./theme";

type Mode = "login" | "register" | "forgot";

// Sign in / sign up / forgot-password card. Registration optionally collects a name;
// "forgot" emails a reset link (handled at /reset).
export default function Auth(props: { onAuthed: () => void }) {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const switchMode = (m: Mode) => {
    setMode(m);
    setError("");
    setSent(false);
  };

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      if (mode === "forgot") {
        await api.forgotPassword(email.trim());
        setSent(true);
        setBusy(false);
        return;
      }
      const res =
        mode === "login"
          ? await api.login(email.trim(), password)
          : await api.register(email.trim(), password, first.trim(), last.trim());
      api.setToken(res.token);
      // Kick off the first verification email right after sign-up (best effort).
      if (mode === "register") api.sendVerification().catch(() => {});
      props.onAuthed();
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };

  const title =
    mode === "login" ? "Sign in to your account" : mode === "register" ? "Create your account" : "Reset your password";
  const cta = mode === "login" ? "Sign in" : mode === "register" ? "Sign up" : "Send reset link";

  return (
    <View style={g.center}>
      <View style={[g.card, { width: 360, maxWidth: "100%" }]}>
        <Text style={g.h1}>Companion Cloud</Text>
        <Text style={g.subtitle}>{title}</Text>

        {mode === "forgot" ? (
          <Text style={g.subtitle}>
            Enter your email and we’ll send you a link to choose a new password.
          </Text>
        ) : null}

        {mode === "register" ? (
          <View style={{ flexDirection: "row", gap: 10 }}>
            <TextInput style={[g.input, { flex: 1 }]} placeholder="First name" value={first} onChangeText={setFirst} />
            <TextInput style={[g.input, { flex: 1 }]} placeholder="Last name" value={last} onChangeText={setLast} />
          </View>
        ) : null}

        <TextInput
          style={g.input}
          placeholder="Email"
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        {mode !== "forgot" ? (
          <TextInput
            style={g.input}
            placeholder="Password"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />
        ) : null}

        {sent ? (
          <Text style={g.success}>If that email is registered, a reset link is on its way.</Text>
        ) : null}
        {error ? <Text style={g.error}>{error}</Text> : null}

        <Pressable style={g.button} onPress={submit} disabled={busy || sent}>
          <Text style={g.buttonText}>{busy ? "…" : cta}</Text>
        </Pressable>

        {mode === "login" ? (
          <Pressable onPress={() => switchMode("forgot")}>
            <Text style={[g.link, { textAlign: "center" }]}>Forgot password?</Text>
          </Pressable>
        ) : null}

        <Pressable onPress={() => switchMode(mode === "login" ? "register" : "login")}>
          <Text style={[g.link, { textAlign: "center" }]}>
            {mode === "login" ? "Need an account? Sign up" : "Have an account? Sign in"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
