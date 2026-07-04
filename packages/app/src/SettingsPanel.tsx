import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Button, Icon, IconButton, Input, Text, colors, radius, shadow, space } from "@companion/design-system";
import { useSync, type AuthMode } from "./SyncProvider";

/** A modal-ish overlay to connect to a sync server and see sync status. Reached from
 * the rail's Settings item — the polish that makes sync manually testable. */
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const sync = useSync();
  const [baseUrl, setBaseUrl] = useState("http://localhost:8080");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async (mode: AuthMode) => {
    setBusy(true);
    setError(null);
    try {
      await sync.connect(baseUrl.trim(), email.trim(), password, mode);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.scrim}>
      {/* click outside to close */}
      <Pressable style={styles.scrimFill} onPress={onClose} aria-label="Close settings" />
      <View style={styles.card}>
        <View style={styles.header}>
          <Text variant="title">Sync</Text>
          <View style={{ flex: 1 }} />
          <IconButton label="Close" size="sm" onPress={onClose}>
            <Icon name="close" size={16} color={colors.textSecondary} />
          </IconButton>
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          {sync.connected ? (
            <>
              <Field label="Signed in">
                <Text tone="secondary">
                  {sync.email} · {baseUrlLabel(baseUrl)}
                </Text>
              </Field>
              <Field label="Status">
                <Text tone={sync.status === "error" ? "danger" : "secondary"}>{statusText(sync)}</Text>
              </Field>
              <View style={styles.row}>
                <Button label={sync.status === "syncing" ? "Syncing…" : "Sync now"} onPress={sync.trigger} />
                <Button label="Disconnect" variant="secondary" onPress={sync.disconnect} />
              </View>
            </>
          ) : (
            <>
              <Field label="Server URL">
                <Input value={baseUrl} onChangeText={setBaseUrl} placeholder="http://localhost:8080" autoCapitalize="none" />
              </Field>
              <Field label="Email">
                <Input value={email} onChangeText={setEmail} placeholder="you@example.com" autoCapitalize="none" />
              </Field>
              <Field label="Password">
                <Input value={password} onChangeText={setPassword} placeholder="••••••••" secureTextEntry autoCapitalize="none" />
              </Field>
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
                Point web and desktop at the same server + account to sync your notes.
              </Text>
            </>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
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
  if (sync.lastSyncedAt) return "last synced " + new Date(sync.lastSyncedAt).toLocaleTimeString();
  return "idle";
}

const styles = {
  scrim: {
    position: "absolute" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    backgroundColor: "rgba(17,17,16,0.28)",
    zIndex: 100,
  },
  scrimFill: { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0 },
  card: {
    width: 420,
    maxWidth: "92%" as const,
    backgroundColor: colors.surfaceCard,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    ...shadow.lg,
    overflow: "hidden" as const,
  },
  header: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    paddingHorizontal: space.xl,
    paddingVertical: space.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  body: { padding: space.xl, gap: space.lg },
  row: { flexDirection: "row" as const, gap: space.md, alignItems: "center" as const },
};
