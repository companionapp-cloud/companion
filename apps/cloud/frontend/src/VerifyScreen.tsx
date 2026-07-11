import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as api from "./api";
import { styles as g } from "./theme";

// Mandatory gate shown after signup/login while the email is unverified. The user can't
// reach the portal (or subscribe) until they confirm — they can resend the link, re-check
// after clicking it, or sign out.
export default function VerifyScreen(props: {
  email: string;
  onVerified: () => void;
  onSignOut: () => void;
}) {
  const [busy, setBusy] = useState<"resend" | "check" | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const resend = async () => {
    setBusy("resend");
    setError("");
    setNote("");
    try {
      await api.sendVerification();
      setNote("Verification email sent. Check your inbox.");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    setBusy("check");
    setError("");
    setNote("");
    try {
      const acct = await api.getAccount();
      if (acct.emailVerified) {
        props.onVerified();
        return;
      }
      setError("Not verified yet — click the link in the email, then try again.");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={g.center}>
      <View style={[g.card, { width: 400, maxWidth: "100%" }]}>
        <View style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: "#f76808" }} />
        <Text style={g.h1}>Verify your email</Text>
        <Text style={g.subtitle}>
          We sent a verification link to <Text style={{ fontWeight: "600" }}>{props.email}</Text>.
          Click it to activate your account and subscribe.
        </Text>
        {note ? <Text style={g.success}>{note}</Text> : null}
        {error ? <Text style={g.error}>{error}</Text> : null}
        <Pressable style={g.button} onPress={check} disabled={busy !== null}>
          <Text style={g.buttonText}>{busy === "check" ? "…" : "I’ve verified — continue"}</Text>
        </Pressable>
        <Pressable style={g.buttonGhost} onPress={resend} disabled={busy !== null}>
          <Text style={g.buttonGhostText}>{busy === "resend" ? "…" : "Resend email"}</Text>
        </Pressable>
        <Pressable onPress={props.onSignOut}>
          <Text style={[g.link, { textAlign: "center" }]}>Sign out</Text>
        </Pressable>
      </View>
    </View>
  );
}
