import { useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Divider, Input, Text, colors, font, radius, space } from "@companion/design-system";
import { auth } from "@companion/core-bridge";
import { useSync, type AuthMode } from "./SyncProvider";
import { RecoveryResetScreen } from "./RecoveryResetScreen";
import { parseResetLink } from "./resetLink";
import { CodeBlock, SettingsField, SettingsNote } from "./settingsUi";

// Re-exported for the package index and the sections that predate settingsUi.
export { SettingsField } from "./settingsUi";

/** The hosted cloud server, used as the default when the Server URL field is left blank. */
const DEFAULT_BASE_URL = "https://portal.companionapp.cloud/api";

/** The sync settings section: connect to a server + account, then see live sync status
 *  (PLAN §7). New accounts are end-to-end encrypted (PLAN §E2EE): registration surfaces a
 *  one-time recovery code, and an encrypted account that has lost its in-memory key (e.g. after a
 *  web reload) prompts to unlock before syncing. Extracted from the old settings modal so it can
 *  render as a settings page section on every platform. */
export function SyncSettings() {
  const sync = useSync();
  useTicker(10_000);
  const [baseUrl, setBaseUrl] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [unlockPassword, setUnlockPassword] = useState("");
  const [enabling, setEnabling] = useState(false);
  const [enablePassword, setEnablePassword] = useState("");
  const [changing, setChanging] = useState(false);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [changed, setChanged] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [linkInput, setLinkInput] = useState("");
  const [forgotNote, setForgotNote] = useState("");
  const [resetTarget, setResetTarget] = useState<{ baseUrl: string; token: string } | null>(null);

  /** The Server URL to use, falling back to the hosted cloud when the field is left blank. */
  const resolvedBaseUrl = baseUrl.trim() || DEFAULT_BASE_URL;

  const sendReset = async () => {
    setBusy(true);
    setError(null);
    setForgotNote("");
    try {
      await auth.forgotPassword(resolvedBaseUrl, email.trim());
      setForgotNote("If that email has an account, a reset link is on its way. Paste it below when it arrives.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const continueWithLink = () => {
    setError(null);
    const parsed = parseResetLink(linkInput);
    if (!parsed) {
      setError("That doesn't look like a valid reset link.");
      return;
    }
    setResetTarget({ baseUrl: parsed.baseUrl ?? resolvedBaseUrl, token: parsed.token });
  };

  const exitForgot = () => {
    setResetTarget(null);
    setForgot(false);
    setLinkInput("");
    setForgotNote("");
    setError(null);
  };

  const connect = async (mode: AuthMode) => {
    setBusy(true);
    setError(null);
    try {
      const { recoveryCode } = await sync.connect(resolvedBaseUrl, email.trim(), password, mode);
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

  // Re-authenticate a dead session in place, reusing the connected account's endpoint + email.
  const reauth = async () => {
    if (!sync.baseUrl || !sync.email) return;
    setBusy(true);
    setError(null);
    try {
      await sync.connect(sync.baseUrl, sync.email, password, "login");
      setPassword("");
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

  const changePassword = async () => {
    setBusy(true);
    setError(null);
    try {
      await sync.changePassword(currentPw, newPw);
      setCurrentPw("");
      setNewPw("");
      setChanging(false);
      setChanged(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Recovery in progress: the user pasted a reset link, so run the recovery flow inline.
  if (resetTarget) {
    return <RecoveryResetScreen baseUrl={resetTarget.baseUrl} token={resetTarget.token} onDone={exitForgot} />;
  }

  const errorLine = error ? <SettingsNote tone="danger">{error}</SettingsNote> : null;

  // Forgot-password entry point: request a reset email and/or paste a reset link to recover.
  if (forgot) {
    return (
      <View style={styles.section}>
        <SettingsField
          label="Forgot your password"
          help="Enter your email to get a reset link, then paste the link from that email below. For an encrypted account you’ll also need your recovery code."
        />
        <SettingsField label="Email">
          <View style={styles.control}>
            <Input value={email} onChangeText={setEmail} placeholder="you@example.com" autoCapitalize="none" />
          </View>
          <View style={styles.row}>
            <Button label={busy ? "…" : "Send reset link"} variant="secondary" onPress={sendReset} disabled={busy} />
          </View>
          {forgotNote ? <SettingsNote tone="secondary">{forgotNote}</SettingsNote> : null}
        </SettingsField>
        <Divider />
        <SettingsField label="Reset link" help="Paste the link from the reset email.">
          <Input mono value={linkInput} onChangeText={setLinkInput} placeholder="https://…" autoCapitalize="none" />
        </SettingsField>
        {errorLine}
        <View style={styles.row}>
          <Button label="Continue" onPress={continueWithLink} disabled={!linkInput.trim()} />
          <Button label="Back to sign in" variant="ghost" onPress={exitForgot} />
        </View>
      </View>
    );
  }

  // One-time recovery code, shown right after registering an encrypted account. It is the only way
  // to recover data if the password is forgotten — the server holds only ciphertext.
  if (recoveryCode) {
    return (
      <View style={styles.section}>
        <SettingsField
          label="Save your recovery code"
          help="This is the only way to recover your notes if you forget your password. Store it somewhere safe — it won’t be shown again."
        >
          <View style={styles.codeBox}>
            <Text variant="mono" style={styles.recoveryCode}>
              {recoveryCode}
            </Text>
          </View>
        </SettingsField>
        <View style={styles.row}>
          <Button label="I’ve saved it" onPress={() => setRecoveryCode(null)} />
        </View>
      </View>
    );
  }

  // Encrypted account whose key isn't loaded (typically a web reload): unlock before syncing.
  if (sync.connected && sync.status === "locked") {
    return (
      <View style={styles.section}>
        <StatusStrip tone="danger" text="locked — unlock to sync" />
        <SettingsField label="Unlock encryption" help={`Enter your password to unlock ${sync.email} on this device.`}>
          <View style={styles.control}>
            <Input
              value={unlockPassword}
              onChangeText={setUnlockPassword}
              onSubmitEditing={() => void unlock()}
              placeholder="Password"
              secureTextEntry
              autoCapitalize="none"
            />
          </View>
        </SettingsField>
        {errorLine}
        <View style={styles.row}>
          <Button label={busy ? "…" : "Unlock"} onPress={unlock} disabled={busy} />
          <Button label="Sign out" variant="ghost" onPress={sync.disconnect} />
        </View>
      </View>
    );
  }

  // The session died (refresh failed): re-authenticate in place with the stored email + endpoint.
  if (sync.connected && sync.needsReauth) {
    return (
      <View style={styles.section}>
        <StatusStrip tone="danger" text="signed out — session expired" />
        <SettingsField label="Session expired" help={`Your session for ${sync.email} ended. Enter your password to sign back in.`}>
          <View style={styles.control}>
            <Input
              value={password}
              onChangeText={setPassword}
              onSubmitEditing={() => void reauth()}
              placeholder="Password"
              secureTextEntry
              autoCapitalize="none"
            />
          </View>
        </SettingsField>
        {errorLine}
        <View style={styles.row}>
          <Button label={busy ? "…" : "Sign in"} onPress={reauth} disabled={busy} />
          <Button label="Sign out" variant="ghost" onPress={sync.disconnect} />
        </View>
      </View>
    );
  }

  if (sync.connected) {
    return (
      <View style={styles.section}>
        <StatusStrip
          tone={sync.status === "error" ? "danger" : sync.status === "syncing" ? "warning" : "success"}
          text={statusText(sync)}
          action={<Button label={sync.status === "syncing" ? "Syncing…" : "Sync now"} size="sm" variant="secondary" onPress={sync.trigger} />}
        />
        <SettingsField label="Server">
          <View style={styles.control}>
            <Input mono disabled value={baseUrlLabel(sync.baseUrl ?? resolvedBaseUrl)} />
          </View>
        </SettingsField>
        <SettingsField label="Account">
          <View style={styles.control}>
            <Input disabled value={sync.email ?? ""} />
          </View>
        </SettingsField>
        <Divider />
        <SettingsField
          label="Encryption"
          help={
            sync.encrypted
              ? "End-to-end encrypted — the server stores ciphertext and never sees your notes."
              : "Not encrypted (legacy account)."
          }
        >
          {!sync.encrypted && !enabling ? (
            <View style={styles.row}>
              <Button label="Enable encryption" variant="secondary" onPress={() => setEnabling(true)} />
            </View>
          ) : null}
          {!sync.encrypted && enabling ? (
            <View style={styles.stack}>
              <SettingsNote>
                Confirm your password to encrypt this account. All notes will be re-uploaded encrypted, and you’ll get a
                one-time recovery code.
              </SettingsNote>
              <View style={styles.control}>
                <Input value={enablePassword} onChangeText={setEnablePassword} placeholder="Current password" secureTextEntry autoCapitalize="none" />
              </View>
              <View style={styles.row}>
                <Button label={busy ? "…" : "Encrypt"} onPress={enableEncryption} disabled={busy} />
                <Button label="Cancel" variant="ghost" onPress={() => setEnabling(false)} />
              </View>
            </View>
          ) : null}
        </SettingsField>
        <Divider />
        <SettingsField
          label="Password"
          help={
            changing && sync.encrypted
              ? "Your notes won’t be re-encrypted — only the key is rewrapped, so this is instant."
              : changed
                ? `Password changed.${sync.encrypted ? " Your data stayed encrypted — no re-upload needed." : ""}`
                : undefined
          }
        >
          {!changing ? (
            <View style={styles.row}>
              <Button
                label="Change password"
                variant="secondary"
                onPress={() => {
                  setChanging(true);
                  setChanged(false);
                }}
              />
            </View>
          ) : (
            <View style={styles.stack}>
              <View style={styles.control}>
                <Input value={currentPw} onChangeText={setCurrentPw} placeholder="Current password" secureTextEntry autoCapitalize="none" />
              </View>
              <View style={styles.control}>
                <Input value={newPw} onChangeText={setNewPw} placeholder="New password" secureTextEntry autoCapitalize="none" />
              </View>
              <View style={styles.row}>
                <Button label={busy ? "…" : "Update password"} onPress={changePassword} disabled={busy} />
                <Button label="Cancel" variant="ghost" onPress={() => setChanging(false)} />
              </View>
            </View>
          )}
        </SettingsField>
        {errorLine}
        <Divider />
        <SettingsField label="Disconnect" help="Stops syncing on this device. Everything already here stays here.">
          <View style={styles.row}>
            <Button label="Disconnect" variant="danger" onPress={sync.disconnect} />
          </View>
        </SettingsField>
        <SelfHosting />
      </View>
    );
  }

  return (
    <View style={styles.section}>
      <SettingsNote tone="secondary">
        Point web, desktop, and mobile at the same server + account to sync everything. New accounts are end-to-end
        encrypted — the server can’t read your notes.
      </SettingsNote>
      <SettingsField label="Server" help="Leave blank to use Companion Cloud.">
        <View style={styles.control}>
          <Input mono value={baseUrl} onChangeText={setBaseUrl} placeholder={DEFAULT_BASE_URL} autoCapitalize="none" />
        </View>
      </SettingsField>
      <SettingsField label="Email">
        <View style={styles.control}>
          <Input value={email} onChangeText={setEmail} placeholder="you@example.com" autoCapitalize="none" />
        </View>
      </SettingsField>
      <SettingsField label="Password">
        <View style={styles.control}>
          <Input
            value={password}
            onChangeText={setPassword}
            onSubmitEditing={() => void connect("login")}
            placeholder="Password"
            secureTextEntry
            autoCapitalize="none"
          />
        </View>
      </SettingsField>
      {errorLine}
      <View style={styles.row}>
        <Button label={busy ? "…" : "Log in"} onPress={() => connect("login")} disabled={busy} />
        <Button label="Register" variant="secondary" onPress={() => connect("register")} disabled={busy} />
        <Button
          label="Forgot password?"
          variant="ghost"
          onPress={() => {
            setError(null);
            setForgot(true);
          }}
        />
      </View>
      <SelfHosting />
    </View>
  );
}

/** The sunken status strip at the top of the section: a 5px state dot, the mono sync state
 *  built from what the controller actually knows, and an optional action. */
function StatusStrip({ tone, text, action }: { tone: "success" | "warning" | "danger"; text: string; action?: React.ReactNode }) {
  return (
    <View style={styles.strip}>
      <View style={[styles.dot, { backgroundColor: colors[tone] }]} />
      <Text variant="mono" tone={tone === "danger" ? "danger" : "secondary"} numberOfLines={2} style={{ flex: 1 }}>
        {text}
      </Text>
      {action}
    </View>
  );
}

/** The self-hosting pointer: the sync server is one container (see the docs' self-hosting page). */
function SelfHosting() {
  return (
    <>
      <Divider />
      <View style={styles.stack}>
        <Text variant="eyebrow" tone="quaternary">
          Self-hosting
        </Text>
        <CodeBlock>{SELF_HOST_SNIPPET}</CodeBlock>
        <SettingsNote>
          The sync server is a single container. Run it, then set Server to its address and register an account there.
        </SettingsNote>
      </View>
    </>
  );
}

const SELF_HOST_SNIPPET =
  "docker run -p 8080:8080 \\\n  -e DATABASE_URL=postgres://user:pass@host:5432/companion \\\n  ghcr.io/chrisdmacrae/companion-server:latest";

function baseUrlLabel(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/** The mono sync state. Re-rendered by useTicker so "12s ago" stays true. */
function statusText(sync: ReturnType<typeof useSync>): string {
  if (sync.status === "error") return sync.lastError ?? "error";
  if (sync.status === "syncing") return "syncing…";
  if (sync.status === "locked") return "locked — unlock to sync";
  if (sync.lastSyncedAt) return `synced ${ago(sync.lastSyncedAt)} ago`;
  return "connected · not synced yet";
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** Re-render on an interval so relative times don't go stale while the page sits open. */
function useTicker(ms: number) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

const styles = {
  section: { gap: space.xl },
  stack: { gap: space.md },
  row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.md, alignItems: "center" as const },
  // Single-line fields stop at 320px — a URL or an email never needs the full column.
  control: { width: "100%" as const, maxWidth: 320 },
  strip: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    padding: space.md,
    backgroundColor: colors.surfaceSunken,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.md,
  },
  dot: { width: 5, height: 5, borderRadius: radius.full, flexShrink: 0 },
  codeBox: {
    paddingVertical: space.lg,
    paddingHorizontal: space.md,
    backgroundColor: colors.surfaceCode,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.md,
    alignItems: "center" as const,
  },
  recoveryCode: { fontSize: font.size.md, letterSpacing: 1, textAlign: "center" as const },
};
