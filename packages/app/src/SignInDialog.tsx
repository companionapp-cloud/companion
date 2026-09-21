import { useState } from "react";
import { View } from "react-native";
import { Button, Divider, Icon, Input, colors, icon, space } from "@companion/design-system";
import { auth } from "@companion/core-bridge";
import { useDialogKeys } from "./ConfirmDialog";
import { Dialog } from "./Dialog";
import { openExternalUrl } from "./externalUrl";
import { parseResetLink } from "./resetLink";
import { CodeBlock, Segmented, SettingsField, SettingsNote } from "./settingsUi";
import { useSync, type AuthMode } from "./SyncProvider";

/** The hosted cloud's API, and the portal where its accounts are created. */
export const CLOUD_BASE_URL = "https://portal.companionapp.cloud/api";
const CLOUD_PORTAL_URL = "https://portal.companionapp.cloud";
const CLOUD_PORTAL_LABEL = "portal.companionapp.cloud";

const SELF_HOST_SNIPPET =
  "docker run -p 8080:8080 \\\n  -e DATABASE_URL=postgres://user:pass@host:5432/companion \\\n  ghcr.io/companionapp-cloud/companion-server:0.5.0";

type Where = "cloud" | "self";

/** Sign in to a sync server (PLAN §7). Two doors, because they really are two different things:
 *
 *   - Companion Cloud: the server is fixed and accounts are created on the portal (that is where
 *     the subscription lives), so this side only signs in and says where to register.
 *   - Self-hosted: the user runs the server, so this side takes its address, shows how to start
 *     one with Docker, and can register the first account on it directly.
 *
 *  "Forgot password?" swaps the dialog's body for the reset request; a pasted reset link closes
 *  the dialog and hands over to the recovery flow. A new encrypted account's one-time recovery
 *  code is handed back through `onConnected` for the page to show. */
export function SignInDialog({
  onClose,
  onConnected,
  onRecover,
}: {
  onClose: () => void;
  onConnected: (recoveryCode?: string) => void;
  onRecover: (target: { baseUrl: string; token: string }) => void;
}) {
  const sync = useSync();
  const [where, setWhere] = useState<Where>("cloud");
  const [serverUrl, setServerUrl] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forgot, setForgot] = useState(false);
  const [linkInput, setLinkInput] = useState("");
  const [forgotNote, setForgotNote] = useState("");

  /** The server this side of the dialog talks to, or null when self-hosted has no address yet. */
  const baseUrl = (): string | null => {
    if (where === "cloud") return CLOUD_BASE_URL;
    const url = serverUrl.trim().replace(/\/+$/, "");
    if (!url) {
      setError("Enter your server’s address.");
      return null;
    }
    return /^https?:\/\//i.test(url) ? url : `https://${url}`;
  };

  const connect = async (mode: AuthMode) => {
    if (busy) return;
    const url = baseUrl();
    if (!url) return;
    if (!email.trim() || !password) return setError("Enter your email and password.");
    setBusy(true);
    setError(null);
    try {
      const { recoveryCode } = await sync.connect(url, email.trim(), password, mode);
      setPassword("");
      onConnected(recoveryCode ?? undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const sendReset = async () => {
    const url = baseUrl();
    if (!url) return;
    if (!email.trim()) return setError("Enter your email.");
    setBusy(true);
    setError(null);
    setForgotNote("");
    try {
      await auth.forgotPassword(url, email.trim());
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
    if (!parsed) return setError("That doesn’t look like a valid reset link.");
    // A reset link names its own server; fall back to this side's only when it doesn't.
    const url = parsed.baseUrl ?? baseUrl();
    if (url) onRecover({ baseUrl: url, token: parsed.token });
  };

  const hints = useDialogKeys({
    onEnter: forgot ? undefined : () => void connect("login"),
    onEscape: busy ? undefined : onClose,
  });

  const whereSwitch = (
    <Segmented
      fill
      options={[
        { value: "cloud", label: "Companion Cloud" },
        { value: "self", label: "Self-hosted" },
      ]}
      value={where}
      onChange={(next) => {
        if (busy) return;
        setWhere(next);
        setError(null);
        setForgotNote("");
      }}
    />
  );

  const serverField =
    where === "self" ? (
      <SettingsField label="Server" help="The address your server is reachable at.">
        <Input mono value={serverUrl} onChangeText={setServerUrl} placeholder="https://companion.example.com" autoCapitalize="none" />
      </SettingsField>
    ) : null;

  if (forgot) {
    return (
      <Dialog
        title="Reset your password"
        onClose={busy ? undefined : onClose}
        footer={
          <>
            <View style={styles.leading}>
              <Button
                label="Back to sign in"
                variant="ghost"
                onPress={() => {
                  setForgot(false);
                  setError(null);
                  setForgotNote("");
                }}
              />
            </View>
            <Button label="Continue" disabled={!linkInput.trim()} onPress={continueWithLink} />
          </>
        }
      >
        {whereSwitch}
        <SettingsNote>
          Get a reset link by email, then paste it below. For an encrypted account you’ll also need your recovery code.
        </SettingsNote>
        {serverField}
        <SettingsField label="Email">
          <Input value={email} onChangeText={setEmail} placeholder="you@example.com" autoCapitalize="none" />
          <View style={styles.row}>
            <Button label={busy ? "…" : "Send reset link"} variant="secondary" disabled={busy} onPress={() => void sendReset()} />
          </View>
          {forgotNote ? <SettingsNote tone="secondary">{forgotNote}</SettingsNote> : null}
        </SettingsField>
        <Divider />
        <SettingsField label="Reset link" help="Paste the link from the reset email.">
          <Input mono value={linkInput} onChangeText={setLinkInput} placeholder="https://…" autoCapitalize="none" />
        </SettingsField>
        {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Sign in to sync"
      width={480}
      onClose={busy ? undefined : onClose}
      footer={
        <>
          <View style={styles.leading}>
            <Button
              label="Forgot password?"
              variant="ghost"
              disabled={busy}
              onPress={() => {
                setError(null);
                setForgot(true);
              }}
            />
          </View>
          <Button label="Cancel" variant="ghost" kbd={hints ? "esc" : undefined} onPress={onClose} />
          {/* Accounts on Companion Cloud are created on the portal, so only a server the user
              runs themselves can register one from here. */}
          {where === "self" ? <Button label="Register" variant="secondary" disabled={busy} onPress={() => void connect("register")} /> : null}
          <Button label={busy ? "…" : "Log in"} kbd={hints ? "⏎" : undefined} disabled={busy} onPress={() => void connect("login")} />
        </>
      }
    >
      {whereSwitch}

      {where === "cloud" ? (
        <View style={styles.stack}>
          <SettingsNote tone="secondary">
            Companion Cloud is the hosted sync server. To create an account, register at {CLOUD_PORTAL_LABEL}, where you also choose a
            plan, then come back and log in here with the same email and password.
          </SettingsNote>
          <View style={styles.row}>
            <Button
              variant="secondary"
              size="sm"
              label={`Open ${CLOUD_PORTAL_LABEL}`}
              icon={<Icon name="external" size={icon.sm} color={colors.textSecondary} />}
              onPress={() => void openExternalUrl(CLOUD_PORTAL_URL).catch(() => undefined)}
            />
          </View>
        </View>
      ) : (
        <View style={styles.stack}>
          <SettingsNote tone="secondary">
            The sync server is a single container. Run it somewhere your devices can reach, enter its address below,
            and register the first account on it.
          </SettingsNote>
          <CodeBlock>{SELF_HOST_SNIPPET}</CodeBlock>
        </View>
      )}

      {serverField}
      <SettingsField label="Email">
        <Input value={email} onChangeText={setEmail} placeholder="you@example.com" autoCapitalize="none" />
      </SettingsField>
      <SettingsField label="Password">
        <Input value={password} onChangeText={setPassword} placeholder="Password" secureTextEntry autoCapitalize="none" />
      </SettingsField>

      {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
      <SettingsNote>Accounts are end-to-end encrypted: the server stores ciphertext and can’t read your notes.</SettingsNote>
    </Dialog>
  );
}

const styles = {
  stack: { gap: space.md },
  row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.md, alignItems: "center" as const },
  leading: { flex: 1, flexDirection: "row" as const },
};
