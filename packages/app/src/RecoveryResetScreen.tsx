import { useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Input, Text, space } from "@companion/design-system";
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
        <Text variant="title">Password reset</Text>
        <Text tone="secondary">Your password has been changed. Sign in with your new password.</Text>
        <Button label="Continue" onPress={onDone} />
      </Card>
    );
  }

  if (loadError) {
    return (
      <Card>
        <Text variant="title">Reset link problem</Text>
        <Text tone="danger">{loadError}</Text>
        <Button label="Close" variant="secondary" onPress={onDone} />
      </Card>
    );
  }

  if (!info) {
    return (
      <Card>
        <Text tone="secondary">Checking your reset link…</Text>
      </Card>
    );
  }

  return (
    <Card>
      <Text variant="title">Reset your password</Text>
      {info.encrypted ? (
        <>
          <Text tone="secondary">
            This account is encrypted. Enter your recovery code to unlock and re-secure your notes
            under a new password.
          </Text>
          <Input value={recoveryCode} onChangeText={setRecoveryCode} placeholder="Recovery code" autoCapitalize="characters" />
        </>
      ) : (
        <Text tone="secondary">Choose a new password for your account.</Text>
      )}
      <Input value={password} onChangeText={setPassword} placeholder="New password" secureTextEntry autoCapitalize="none" />
      <Input value={confirm} onChangeText={setConfirm} placeholder="Confirm new password" secureTextEntry autoCapitalize="none" />
      {error ? (
        <Text tone="danger" variant="caption">
          {error}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: space.md }}>
        <Button label={busy ? "…" : "Reset password"} onPress={submit} disabled={busy} />
        <Button label="Cancel" variant="secondary" onPress={onDone} />
      </View>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl }}>
      <View style={{ width: 400, maxWidth: "100%", gap: space.lg }}>{children}</View>
    </View>
  );
}
