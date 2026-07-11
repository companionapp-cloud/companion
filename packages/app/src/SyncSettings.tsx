import { useState } from "react";
import { View } from "react-native";
import { Button, Input, Text, space } from "@companion/design-system";
import { useSync, type AuthMode } from "./SyncProvider";

/** The sync settings section: connect to a server + account, then see live sync status
 *  (PLAN §7). New accounts are end-to-end encrypted (PLAN §E2EE): registration surfaces a
 *  one-time recovery code, and an encrypted account that has lost its in-memory key (e.g. after a
 *  web reload) prompts to unlock before syncing. Extracted from the old settings modal so it can
 *  render as a settings page section on every platform. */
export function SyncSettings() {
  const sync = useSync();
  const [baseUrl, setBaseUrl] = useState("http://localhost:8080");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [enabling, setEnabling] = useState(false);
  const [enablePassword, setEnablePassword] = useState("");

  const connect = async (mode: AuthMode) => {
    setBusy(true);
    setError(null);
    try {
      const { recoveryCode } = await sync.connect(baseUrl.trim(), email.trim(), password, mode);
      setPassword("");
      if (recoveryCode) setRecoveryCode(recoveryCode);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const unlock = async () => {
    setBusy(true);
    setError(null);
    try {
      await sync.unlock(unlockPassword);
      setUnlockPassword("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const enableEncryption = async () => {
    setBusy(true);
    setError(null);
    try {
      const { recoveryCode } = await sync.enableEncryption(enablePassword);
      setEnablePassword("");
      setEnabling(false);
      if (recoveryCode) setRecoveryCode(recoveryCode);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // One-time recovery code, shown right after registering an encrypted account. It is the only way
  // to recover data if the password is forgotten — the server holds only ciphertext.
  if (recoveryCode) {
    return (
      <View style={{ gap: space.lg }}>
        <SettingsField label="Save your recovery code">
          <Text tone="secondary">
            This is the only way to recover your notes if you forget your password. Store it
            somewhere safe — it won't be shown again.
          </Text>
          <View style={styles.codeBox}>
            <Text style={{ fontFamily: "monospace", fontSize: 16, letterSpacing: 1 }}>{recoveryCode}</Text>
          </View>
        </SettingsField>
        <Button label="I've saved it" onPress={() => setRecoveryCode(null)} />
      </View>
    );
  }

  // Encrypted account whose key isn't loaded (typically a web reload): unlock before syncing.
  if (sync.connected && sync.status === "locked") {
    return (
      <View style={{ gap: space.lg }}>
        <SettingsField label="Unlock encryption">
          <Text tone="secondary">Enter your password to unlock {sync.email} on this device.</Text>
        </SettingsField>
        <SettingsField label="Password">
          <Input value={unlockPassword} onChangeText={setUnlockPassword} placeholder="••••••••" secureTextEntry autoCapitalize="none" />
        </SettingsField>
        {error ? (
          <Text tone="danger" variant="caption">
            {error}
          </Text>
        ) : null}
        <View style={styles.row}>
          <Button label={busy ? "…" : "Unlock"} onPress={unlock} disabled={busy} />
          <Button label="Sign out" variant="secondary" onPress={sync.disconnect} />
        </View>
      </View>
    );
  }

  if (sync.connected) {
    return (
      <View style={{ gap: space.lg }}>
        <SettingsField label="Signed in">
          <Text tone="secondary">
            {sync.email} · {baseUrlLabel(baseUrl)}
          </Text>
        </SettingsField>
        <SettingsField label="Encryption">
          <Text tone="secondary">{sync.encrypted ? "End-to-end encrypted" : "Not encrypted (legacy account)"}</Text>
          {!sync.encrypted && !enabling ? (
            <Button label="Enable encryption" variant="secondary" onPress={() => setEnabling(true)} />
          ) : null}
          {!sync.encrypted && enabling ? (
            <View style={{ gap: space.sm }}>
              <Text tone="tertiary" variant="caption">
                Confirm your password to encrypt this account. All notes will be re-uploaded
                encrypted, and you'll get a one-time recovery code.
              </Text>
              <Input value={enablePassword} onChangeText={setEnablePassword} placeholder="Current password" secureTextEntry autoCapitalize="none" />
              <View style={styles.row}>
                <Button label={busy ? "…" : "Encrypt"} onPress={enableEncryption} disabled={busy} />
                <Button label="Cancel" variant="secondary" onPress={() => setEnabling(false)} />
              </View>
            </View>
          ) : null}
        </SettingsField>
        <SettingsField label="Status">
          <Text tone={sync.status === "error" ? "danger" : "secondary"}>{statusText(sync)}</Text>
        </SettingsField>
        <View style={styles.row}>
          <Button label={sync.status === "syncing" ? "Syncing…" : "Sync now"} onPress={sync.trigger} />
          <Button label="Disconnect" variant="secondary" onPress={sync.disconnect} />
        </View>
      </View>
    );
  }

  return (
    <View style={{ gap: space.lg }}>
      <SettingsField label="Server URL">
        <Input value={baseUrl} onChangeText={setBaseUrl} placeholder="http://localhost:8080" autoCapitalize="none" />
      </SettingsField>
      <SettingsField label="Email">
        <Input value={email} onChangeText={setEmail} placeholder="you@example.com" autoCapitalize="none" />
      </SettingsField>
      <SettingsField label="Password">
        <Input value={password} onChangeText={setPassword} placeholder="••••••••" secureTextEntry autoCapitalize="none" />
      </SettingsField>
      {error ? (
        <Text tone="danger" variant="caption">
          {error}
        </Text>
      ) : null}
      <View style={styles.row}>
        <Button label={busy ? "…" : "Log in"} onPress={() => connect("login")} disabled={busy} />
        <Button label="Register" variant="secondary" onPress={() => connect("register")} disabled={busy} />
      </View>
      <Text tone="tertiary" variant="caption">
        Point web, desktop, and mobile at the same server + account to sync everything. New accounts
        are end-to-end encrypted — the server can't read your notes.
      </Text>
    </View>
  );
}

/** A labeled settings field wrapper, shared across the settings sections. */
export function SettingsField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: space.sm }}>
      <Text variant="caption" tone="tertiary" style={{ fontWeight: "600" }}>
        {label}
      </Text>
      {children}
    </View>
  );
}

function baseUrlLabel(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function statusText(sync: ReturnType<typeof useSync>): string {
  if (sync.status === "error") return sync.lastError ?? "error";
  if (sync.status === "syncing") return "syncing…";
  if (sync.status === "locked") return "locked — unlock to sync";
  if (sync.lastSyncedAt) return "last synced " + new Date(sync.lastSyncedAt).toLocaleTimeString();
  return "idle";
}

const styles = {
  row: { flexDirection: "row" as const, gap: space.md, alignItems: "center" as const },
  codeBox: {
    padding: space.md,
    borderRadius: 8,
    backgroundColor: "rgba(127,127,127,0.12)",
    alignItems: "center" as const,
  },
};
