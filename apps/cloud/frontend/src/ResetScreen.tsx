import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import * as api from "./api";
import { styles as g } from "./theme";

// Reached from the emailed reset link (/reset?token=…). Sets a new password, then hands
// off to the sign-in screen.
export default function ResetScreen(props: { token: string; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

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
        <Text style={g.h1}>Choose a new password</Text>
        {!props.token ? (
          <>
            <Text style={g.error}>This reset link is missing its token.</Text>
            <Pressable style={g.button} onPress={props.onDone}>
              <Text style={g.buttonText}>Back to sign in</Text>
            </Pressable>
          </>
        ) : done ? (
          <>
            <Text style={g.success}>Your password has been reset.</Text>
            <Pressable style={g.button} onPress={props.onDone}>
              <Text style={g.buttonText}>Sign in</Text>
            </Pressable>
          </>
        ) : (
          <>
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
