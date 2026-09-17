import { useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Input, Text, Wordmark, colors, radius, space } from "@companion/design-system";
import { auth, keys, cryptoApi } from "@companion/core-bridge";
import { useCore } from "./CoreContext";

/** The forgot-password recovery flow, reached from a reset email deep link (PLAN §E2EE). It runs
 * in the app — not the cloud portal — so the master-key unwrap/rewrap uses the tested local crypto
 * core (native on desktop/mobile), never server-delivered JS handling the recovery code.
 *
 * For an encrypted account: recovery code + new password → unlock the master key with the recovery
 * code → rewrap it under the new password → send the new credential + rewrapped key to the server
 * (authorized by the emailed token). For a plaintext account it's a plain new-password reset. On
 * success the user signs in normally with the new password. */
export function RecoveryResetScreen({ baseUrl, token, onDone }: { baseUrl: string; token: string; onDone: () => void }) {
  const { core } = useCore();
  const [info, setInfo] = useState<auth.ResetInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Look up whether the account is encrypted (and fetch its recovery blob) for this reset token.
  useEffect(() => {
    let cancelled = false;
    auth
      .resetInfo(baseUrl, token)
      .then((i) => !cancelled && setInfo(i))
      .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [baseUrl, token]);

  const submit = async () => {
    if (!info) return;
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const crypto = cryptoApi(core);
      if (info.encrypted) {
        if (!info.recoveryWrapped) throw new Error("this account has no recovery key");
        // Unwrap the master key with the recovery code, then rewrap it under the new password.
        await crypto.unlockWithRecovery(recoveryCode, info.recoveryWrapped);
        const rw = await crypto.rewrap(password);
        const material = { ...keys.materialFromSetup(rw), recoveryWrapped: info.recoveryWrapped };
        // The server credential for an encrypted account is the derived auth key.
        await auth.resetPassword(baseUrl, token, rw.authKeyHex, material);
      } else {
        await auth.resetPassword(baseUrl, token, password);
      }
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Card>
        <Text variant="heading">Password reset</Text>
        <Text tone="secondary">Your password has been changed. Sign in with your new password.</Text>
        <Button label="Continue" fullWidth onPress={onDone} />
      </Card>
    );
  }

  if (loadError) {
    return (
      <Card>
        <Text variant="heading">Reset link problem</Text>
        <Text variant="caption" tone="danger">
          {loadError}
        </Text>
        <Button label="Close" variant="secondary" fullWidth onPress={onDone} />
      </Card>
    );
  }

  if (!info) {
    return (
      <Card>
        <Text variant="caption" tone="tertiary">
          Checking your reset link…
        </Text>
      </Card>
    );
  }

  return (
    <Card>
      <Text variant="heading">Reset your password</Text>
      <Text tone="secondary">
        {info.encrypted
          ? "This account is encrypted. Enter your recovery code to unlock and re-secure your notes under a new password."
          : "Choose a new password for your account."}
      </Text>
      <View style={styles.fields}>
        {info.encrypted ? (
          <Field label="Recovery code">
            <Input mono value={recoveryCode} onChangeText={setRecoveryCode} placeholder="The code you saved when encryption was set up" autoCapitalize="characters" />
          </Field>
        ) : null}
        <Field label="New password">
          <Input value={password} onChangeText={setPassword} placeholder="At least 6 characters" secureTextEntry autoCapitalize="none" />
        </Field>
        <Field label="Confirm new password">
          <Input
            value={confirm}
            onChangeText={setConfirm}
            onSubmitEditing={() => void submit()}
            placeholder="Type it again"
            secureTextEntry
            autoCapitalize="none"
          />
        </Field>
      </View>
      {error ? (
        <Text tone="danger" variant="caption">
          {error}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Button label={busy ? "…" : "Reset password"} fullWidth onPress={submit} disabled={busy} />
        <Button label="Cancel" variant="ghost" fullWidth onPress={onDone} />
      </View>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text variant="label">{label}</Text>
      {children}
    </View>
  );
}

/** The centred 360px card every state of the flow renders in: wordmark, then the content.
 *  Hairline and a 6px radius — it sits on the page, so no shadow. */
function Card({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.page}>
      <View style={styles.card}>
        <Wordmark />
        {children}
      </View>
    </View>
  );
}

const styles = {
  page: { flex: 1, alignItems: "center" as const, justifyContent: "center" as const, padding: space.xl },
  card: {
    width: 360,
    maxWidth: "100%" as const,
    gap: space.lg,
    padding: space.xl2,
    backgroundColor: colors.surfaceCard,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.lg,
  },
  fields: { gap: space.ml },
  field: { gap: space.xs },
  actions: { gap: space.sm },
};
