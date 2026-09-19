import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import type { CalendarAccount } from "@companion/core-bridge";
import { Button, Icon, IconButton, Input, Text, colors, icon, radius, row, space, useDensity } from "@companion/design-system";
import { useCalendar } from "./CalendarProvider";
import { ConfirmDialog, useDialogKeys } from "./ConfirmDialog";
import { Dialog } from "./Dialog";
import { MembershipPicker } from "./MembershipPicker";
import { Segmented, SettingsField, SettingsNote } from "./settingsUi";

// Providers whose CalDAV address is fixed, so the user only types a login. "Other" is any
// standards-compliant server (Nextcloud, Radicale, Synology, …). Google is the odd one out: its
// CalDAV endpoint only accepts OAuth, so it has a sign-in button instead of a password field
// (PLAN-caldav.md §9) and is only offered where this build carries a Google client id.
type PasswordProvider = "icloud" | "fastmail" | "other";
type Provider = "google" | PasswordProvider;
const PROVIDERS: Record<PasswordProvider, { label: string; serverUrl: string; userHint: string; passwordHelp: string }> = {
  icloud: {
    label: "iCloud",
    serverUrl: "https://caldav.icloud.com",
    userHint: "Apple Account email",
    passwordHelp: "Use an app-specific password from account.apple.com › Sign-In and Security — not your Apple Account password.",
  },
  fastmail: {
    label: "Fastmail",
    serverUrl: "https://caldav.fastmail.com",
    userHint: "you@fastmail.com",
    passwordHelp: "Use an app password from Fastmail › Settings › Privacy & Security, with access to calendars.",
  },
  other: {
    label: "Other",
    serverUrl: "",
    userHint: "Username",
    passwordHelp: "Any CalDAV server works: Nextcloud, Radicale, Synology, Zimbra.",
  },
};

/** The Accounts section of calendar settings (PLAN-caldav.md): the connected CalDAV accounts and
 *  their calendars, and one button that opens the add-account flow in a dialog. Accounts are
 *  two-way — their events can be created and edited here. Companion talks to the provider
 *  directly from this device, so accounts can only be added where that is possible (desktop,
 *  mobile); on web they are listed, and their events stay editable, but the button gives way to
 *  a note saying where to add one. */
export function CalendarAccountsSettings() {
  const { accounts, canAddAccounts, canAddGoogle, connectGoogle, rescanAccount, removeAccount } = useCalendar();
  const touch = useDensity() === "touch";
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [removing, setRemoving] = useState<CalendarAccount | null>(null);
  // The account, or one of its calendars, being filed into projects (PLAN §6.6).
  const [filing, setFiling] = useState<{ type: "calendar" | "calendar_account"; id: string } | null>(null);

  const rescan = async (id: string) => {
    setRescanning(id);
    setError(null);
    try {
      await rescanAccount(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRescanning(null);
    }
  };

  const reconnect = async (id: string) => {
    if (reconnecting) return;
    setReconnecting(id);
    setError(null);
    try {
      await connectGoogle(id).result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message !== "cancelled") setError(message);
    } finally {
      setReconnecting(null);
    }
  };

  return (
    <View style={styles.section}>
      <View style={styles.head}>
        <Text variant="eyebrow" tone="quaternary">
          Accounts{accounts.length > 0 ? ` · ${accounts.length}` : ""}
        </Text>
        <SettingsNote>Two-way calendars from iCloud, Google, Fastmail or any CalDAV server. You can add and edit their events here.</SettingsNote>
      </View>

      {accounts.map((a) => (
        <View key={a.id} style={styles.account}>
          <View style={[styles.accountHead, { minHeight: touch ? row.touch : 32 }]}>
            <View style={styles.accountTitle}>
              <Text variant="label" numberOfLines={1}>
                {a.name}
              </Text>
              <Text variant="mono" tone="quaternary" numberOfLines={1}>
                {a.username}
              </Text>
            </View>
            {canAddGoogle && a.authKind === "oauth-google" && a.lastError ? (
              <Button
                variant="secondary"
                size="sm"
                label={reconnecting === a.id ? "Waiting…" : "Reconnect"}
                disabled={reconnecting !== null}
                onPress={() => void reconnect(a.id)}
              />
            ) : null}
            <IconButton label={`Add ${a.name} to projects`} size={touch ? undefined : "sm"} onPress={() => setFiling({ type: "calendar_account", id: a.id })}>
              <Icon name="folder" size={touch ? icon.lg : 13} color={colors.textTertiary} />
            </IconButton>
            {canAddAccounts && a.hasCredential ? (
              <IconButton label={`Look for new calendars in ${a.name}`} size={touch ? undefined : "sm"} onPress={() => void rescan(a.id)}>
                <Icon name="refresh" size={touch ? icon.lg : 13} color={rescanning === a.id ? colors.textQuaternary : colors.textTertiary} />
              </IconButton>
            ) : null}
            <IconButton label={`Remove ${a.name}`} size={touch ? undefined : "sm"} onPress={() => setRemoving(a)}>
              <Icon name="trash" size={touch ? icon.lg : 13} color={colors.textTertiary} />
            </IconButton>
          </View>
          {a.calendars.map((c) => (
            <View key={c.id} style={[styles.calendarRow, { minHeight: touch ? row.touch : 26 }]}>
              <View style={[styles.swatch, { backgroundColor: c.color ?? colors.borderStrong }]} />
              <Text variant="caption" tone="secondary" numberOfLines={1} style={{ flex: 1 }}>
                {c.name}
              </Text>
              {c.readOnly ? (
                <Text variant="mono" tone="quaternary">
                  read-only
                </Text>
              ) : null}
              <IconButton label={`Add ${c.name} to projects`} size={touch ? undefined : "sm"} onPress={() => setFiling({ type: "calendar", id: c.id })}>
                <Icon name="folder" size={touch ? icon.lg : 12} color={colors.textQuaternary} />
              </IconButton>
            </View>
          ))}
          {a.lastError ? <SettingsNote tone="danger">{a.lastError}</SettingsNote> : null}
          {!a.hasCredential ? (
            <SettingsNote>
              {a.authKind === "oauth-google"
                ? "This device can’t sync this Google account directly — it was connected from another kind of device. Changes made here are sent by that one."
                : "This device has no password for this account, so it can’t sync it directly. Changes made here are sent by the device the account was added on."}
            </SettingsNote>
          ) : null}
        </View>
      ))}

      {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}

      {canAddAccounts ? (
        <View style={styles.buttonRow}>
          <Button variant="secondary" label="Add account" onPress={() => setAdding(true)} />
        </View>
      ) : (
        <SettingsNote>
          {accounts.length > 0
            ? "Events in these calendars can be edited here; changes are delivered by your desktop or mobile app."
            : "Accounts are added from the desktop or mobile app. A browser can’t reach those servers directly, and routing your password through ours would defeat end-to-end encryption."}
        </SettingsNote>
      )}

      {adding ? <AddAccountDialog onClose={() => setAdding(false)} /> : null}
      {filing ? (
        <MembershipPicker
          portal
          entityType={filing.type}
          entityId={filing.id}
          subtitle={
            filing.type === "calendar_account"
              ? "Every calendar in this account — including ones added later — shows in the projects you tick."
              : "This calendar’s events show in the projects you tick."
          }
          onClose={() => setFiling(null)}
        />
      ) : null}
      {removing ? (
        <ConfirmDialog
          portal
          title={`Remove ${removing.name}?`}
          message="Its calendars and events disappear from Companion on all your devices. Nothing is deleted from the account itself."
          confirmLabel="Remove"
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await removeAccount(removing.id);
            setRemoving(null);
          }}
        />
      ) : null}
    </View>
  );
}

/** The add-account flow: pick a provider, then either sign in with Google or enter a login. The
 *  login is checked against the server before anything is saved, so a dialog that closes means an
 *  account that works. */
function AddAccountDialog({ onClose }: { onClose: () => void }) {
  const { canAddGoogle, connectGoogle, addAccount } = useCalendar();
  // Offer Google first where it's available — it is the account most people have.
  const [provider, setProvider] = useState<Provider>(canAddGoogle ? "google" : "icloud");
  const [serverUrl, setServerUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A Google sign-in in progress: the browser is open and we are waiting for the user.
  const [signingIn, setSigningIn] = useState(false);
  const cancelSignIn = useRef<(() => void) | null>(null);
  // Closing the dialog abandons a sign-in rather than leaving the core listening for it.
  useEffect(() => () => cancelSignIn.current?.(), []);

  const preset = PROVIDERS[provider === "google" ? "other" : provider];

  const signInWithGoogle = async () => {
    if (signingIn) return;
    setError(null);
    setSigningIn(true);
    const flow = connectGoogle();
    cancelSignIn.current = flow.cancel;
    try {
      await flow.result;
      cancelSignIn.current = null;
      onClose();
    } catch (e) {
      cancelSignIn.current = null;
      const message = e instanceof Error ? e.message : String(e);
      if (message !== "cancelled") setError(message);
      setSigningIn(false);
    }
  };

  const add = async () => {
    if (busy || provider === "google") return;
    const url = provider === "other" ? serverUrl.trim() : preset.serverUrl;
    if (!url) return setError("Enter the server address.");
    if (!username.trim()) return setError("Enter the username.");
    if (!password) return setError("Enter the password.");
    setBusy(true);
    setError(null);
    try {
      await addAccount({ name: provider === "other" ? undefined : preset.label, serverUrl: url, username: username.trim(), password });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // The password never outlives a failed attempt.
      setPassword("");
      setBusy(false);
    }
  };

  const working = busy || signingIn;
  const hints = useDialogKeys({ onEnter: provider === "google" ? undefined : () => void add(), onEscape: busy ? undefined : onClose });

  return (
    <Dialog
      title="Add a calendar account"
      onClose={working ? undefined : onClose}
      footer={
        <>
          <Button label="Cancel" variant="ghost" kbd={hints ? "esc" : undefined} onPress={onClose} />
          {provider === "google" ? (
            <Button label={signingIn ? "Waiting for Google…" : "Sign in with Google"} disabled={signingIn} onPress={() => void signInWithGoogle()} />
          ) : (
            <Button label={busy ? "Checking…" : "Add account"} kbd={hints ? "⏎" : undefined} disabled={busy} onPress={() => void add()} />
          )}
        </>
      }
    >
      <Segmented
        fill
        options={[
          ...(canAddGoogle ? [{ value: "google" as Provider, label: "Google" }] : []),
          ...(Object.keys(PROVIDERS) as PasswordProvider[]).map((p) => ({ value: p as Provider, label: PROVIDERS[p].label })),
        ]}
        value={provider}
        onChange={(p) => {
          if (working) return;
          setProvider(p);
          setError(null);
        }}
      />

      {provider === "google" ? (
        <SettingsNote>
          Google’s sign-in opens in your browser; Companion never sees your Google password. You can remove its access
          any time at myaccount.google.com/permissions.
        </SettingsNote>
      ) : (
        <>
          {provider === "other" ? (
            <SettingsField label="Server" help="https is required, except for a server on your own network.">
              <Input mono value={serverUrl} onChangeText={setServerUrl} placeholder="cloud.example.com/remote.php/dav" autoCapitalize="none" />
            </SettingsField>
          ) : null}
          <SettingsField label="Username">
            <Input autoFocus value={username} onChangeText={setUsername} placeholder={preset.userHint} autoCapitalize="none" />
          </SettingsField>
          <SettingsField label="Password" help={preset.passwordHelp}>
            <Input value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" />
          </SettingsField>
        </>
      )}

      {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
      <SettingsNote>
        Companion connects to your calendar provider directly from this device. Your sign-in and events sync between
        your devices end-to-end encrypted; the Companion server never sees them.
      </SettingsNote>
    </Dialog>
  );
}

const styles = {
  section: { gap: space.lg },
  head: { gap: space.xs },
  buttonRow: { flexDirection: "row" as const },
  account: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.lg,
    paddingLeft: space.ml,
    paddingRight: space.xs,
    paddingBottom: space.sm,
    gap: 2,
  },
  accountHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm },
  accountTitle: { flex: 1, minWidth: 0, flexDirection: "row" as const, alignItems: "baseline" as const, gap: space.md },
  calendarRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.md },
  swatch: { width: 8, height: 8, borderRadius: radius.xs, flexShrink: 0 },
};
