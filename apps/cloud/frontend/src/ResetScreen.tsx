import { useEffect, useState } from "react";
import { Linking, Pressable, Text, TextInput, View } from "react-native";
import * as api from "./api";
import { styles as g } from "./theme";

// Reached from the emailed reset link (/reset?token=…). A plaintext account resets here; an
// end-to-end-encrypted account is handed off to the app, which alone can rewrap the master key with
// the recovery code (PLAN §E2EE) — the portal can't and mustn't.
export default function ResetScreen(props: { token: string; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [encrypted, setEncrypted] = useState<boolean | null>(null);
  const [appLink, setAppLink] = useState(""); // deep link that auto-opens the app (empty if CLOUD_APP_URL unset)
  const [pasteLink, setPasteLink] = useState(""); // self-contained link (carries token + server) to paste into the app

  // Determine whether this account is encrypted (→ hand off to the app) and build the recovery link.
  useEffect(() => {
    if (!props.token) return;
    let cancelled = false;
    (async () => {
      try {
        const [info, config] = await Promise.all([api.resetInfo(props.token), api.getConfig()]);
        if (cancelled) return;
        setEncrypted(info.encrypted);
        if (info.encrypted) {
          // The paste link always carries the API base (server) so the app knows where to send the
          // reset, regardless of which server URL the user has typed in its login form.
          const query = `resetToken=${encodeURIComponent(props.token)}&server=${encodeURIComponent(config.syncUrl)}`;
          setPasteLink(config.appUrl ? `${config.appUrl}${config.appUrl.includes("?") ? "&" : "?"}${query}` : `?${query}`);
          if (config.appUrl) setAppLink(`${config.appUrl}${config.appUrl.includes("?") ? "&" : "?"}${query}`);
        }
      } catch {
        if (!cancelled) setEncrypted(false); // fall back to the plain form; the reset will 409 if actually encrypted
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.token]);

  const submit = async () => {
    setError("");
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don’t match.");
      return;
    }
    setBusy(true);
    try {
      await api.resetPassword(props.token, password);
      api.setToken(null); // reset revokes sessions server-side; sign in fresh
      setDone(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={g.center}>
      <View style={[g.card, { width: 360, maxWidth: "100%" }]}>
        {!props.token ? (
          <>
            <Text style={g.h1}>Reset link problem</Text>
            <Text style={g.error}>This reset link is missing its token.</Text>
            <Pressable style={g.button} onPress={props.onDone}>
              <Text style={g.buttonText}>Back to sign in</Text>
            </Pressable>
          </>
        ) : done ? (
          <>
            <Text style={g.h1}>Password reset</Text>
            <Text style={g.success}>Your password has been reset.</Text>
            <Pressable style={g.button} onPress={props.onDone}>
              <Text style={g.buttonText}>Sign in</Text>
            </Pressable>
          </>
        ) : encrypted === null ? (
          // Brief lookup to decide the path — no password fields are shown until we know it's a
          // plaintext account, so an encrypted account never sees a (useless) password form.
          <>
            <Text style={g.h1}>Reset your password</Text>
            <Text style={g.subtitle}>Checking your reset link…</Text>
          </>
        ) : encrypted ? (
          // Encrypted account: the portal can't reset the password (it can't rewrap the encryption
          // key), so it hands straight off to the app — no password form at all.
          <>
            <Text style={g.h1}>Finish in the app</Text>
            <Text style={g.subtitle}>
              This account is end-to-end encrypted, so your password can only be reset in the
              Companion app — where your recovery code re-secures your encryption key.
            </Text>
            {appLink ? (
              <Pressable style={g.button} onPress={() => Linking.openURL(appLink)}>
                <Text style={g.buttonText}>Open the Companion app →</Text>
              </Pressable>
            ) : null}
            <Text style={g.subtitle}>
              {appLink ? "If the app doesn't open, in" : "In"} the Companion app, open Settings › Sync ›
              Forgot password and paste this reset link:
            </Text>
            <Text selectable style={[g.link, { textAlign: "center" }]}>
              {pasteLink}
            </Text>
            <Pressable onPress={props.onDone}>
              <Text style={[g.link, { textAlign: "center" }]}>Back to sign in</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={g.h1}>Choose a new password</Text>
            <TextInput
              style={g.input}
              placeholder="New password"
              secureTextEntry
              value={password}
              onChangeText={setPassword}
            />
            <TextInput
              style={g.input}
              placeholder="Confirm new password"
              secureTextEntry
              value={confirm}
              onChangeText={setConfirm}
            />
            {error ? <Text style={g.error}>{error}</Text> : null}
            <Pressable style={g.button} onPress={submit} disabled={busy}>
              <Text style={g.buttonText}>{busy ? "…" : "Reset password"}</Text>
            </Pressable>
            <Pressable onPress={props.onDone}>
              <Text style={[g.link, { textAlign: "center" }]}>Back to sign in</Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}
