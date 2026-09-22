import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Divider, Icon, Input, Text, colors, icon, radius, row, space, useDensity, type IconName } from "@companion/design-system";
import type { DataKind, DataSummary } from "@companion/core-bridge";
import { ConfirmDialog, useDialogKeys } from "./ConfirmDialog";
import { useCore } from "./CoreContext";
import { Dialog } from "./Dialog";
import { SettingsField, SettingsNote } from "./settingsUi";
import { useSync } from "./SyncProvider";

/** The kinds a row clears on its own. Object types, agents and exports only go with "Clear all
 *  data": they are settings more than content, and each has its own page. */
interface ClearRow {
  kind: DataKind;
  label: string;
  icon: IconName;
  count: (s: DataSummary) => number;
  /** What a clear takes, for the confirmation: "124 notes". */
  what: (s: DataSummary) => string;
  /** A second line for the confirmation, when what else goes, or stays, is worth saying. */
  note?: string;
}

const ROWS: ClearRow[] = [
  {
    kind: "notes",
    label: "Notes",
    icon: "notes",
    count: (s) => s.notes,
    what: (s) => plural(s.notes, "note"),
    note: "Files only they use are deleted too.",
  },
  { kind: "tasks", label: "Tasks", icon: "tasks", count: (s) => s.tasks, what: (s) => plural(s.tasks, "task") },
  {
    kind: "canvases",
    label: "Canvases",
    icon: "canvas",
    count: (s) => s.canvases,
    what: (s) => plural(s.canvases, "canvas", "canvases"),
  },
  { kind: "chats", label: "Chats", icon: "chat", count: (s) => s.chats, what: (s) => plural(s.chats, "chat") },
  {
    kind: "calendar",
    label: "Calendars",
    icon: "calendar",
    count: (s) => s.calendars,
    // An account whose calendars are all gone still counts, so it can be cleared too.
    what: (s) =>
      s.calendarAccounts > 0 ? `${plural(s.calendars, "calendar")} and ${plural(s.calendarAccounts, "account")}` : plural(s.calendars, "calendar"),
    note: "Nothing is deleted from your calendar provider.",
  },
  {
    kind: "areas",
    label: "Areas and projects",
    icon: "folder",
    count: (s) => s.areas + s.projects,
    what: (s) => `${plural(s.areas, "area")} and ${plural(s.projects, "project")}`,
    note: "What they hold stays, unfiled.",
  },
];

type Pending = { kind: "row"; row: ClearRow } | { kind: "all" };

/** Settings › Danger Zone: permanently clear one tool's data or all of it, and, when signed in,
 *  request deletion of the sync account. A clear skips the Trash; its deletions sync, so a
 *  signed-in clear leaves every device. Account deletion waits 30 days and signing in before
 *  then cancels it (the server's side of that lives in syncserver/account.go). */
export function DangerZoneSettings() {
  const { core, data } = useCore();
  const sync = useSync();
  const touch = useDensity() === "touch";
  const [summary, setSummary] = useState<DataSummary | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [scheduled, setScheduled] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    data
      .summary()
      .then(setSummary)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [data]);
  useEffect(reload, [reload]);
  // A sync or another screen changes the counts underneath the page.
  useEffect(() => core.on("data.changed", reload), [core, reload]);

  const where = sync.connected ? "from all your devices" : "from this device";
  const total = summary ? Object.values(summary).reduce((a, b) => a + b, 0) : 0;

  const clear = async (p: Pending) => {
    setError(null);
    try {
      if (p.kind === "all") await data.clearAll();
      else await data.clear([p.row.kind]);
      setPending(null);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Rethrown so the dialog re-enables its button; it stays open to retry or cancel.
      throw e;
    }
  };

  return (
    <View style={styles.section}>
      <SettingsField label="Clear data" help={sync.connected ? "Deletes from all your devices. Skips the Trash." : "Deletes from this device. Skips the Trash."}>
        <View style={styles.list}>
          {ROWS.map((r, i) => {
            const n = summary ? r.count(summary) : null;
            const empty = r.kind === "calendar" ? !!summary && summary.calendars + summary.calendarAccounts === 0 : n === 0;
            return (
              <View key={r.kind} style={[styles.row, { minHeight: touch ? row.touch : 36 }, i < ROWS.length - 1 ? styles.rowDivider : null]}>
                <Icon name={r.icon} size={touch ? icon.lg : icon.sm} color={colors.textSecondary} />
                <Text variant="label" style={styles.rowLabel} numberOfLines={1}>
                  {r.label}
                </Text>
                <Text variant="mono" tone="tertiary">
                  {n == null ? "…" : String(n)}
                </Text>
                <Button label="Clear" variant="danger" size="sm" disabled={!summary || empty} onPress={() => setPending({ kind: "row", row: r })} />
              </View>
            );
          })}
        </View>
        <View style={styles.actions}>
          <Button label="Clear all data" variant="danger" disabled={!summary || total === 0} onPress={() => setPending({ kind: "all" })} />
        </View>
      </SettingsField>
      {error && !pending ? <SettingsNote tone="danger">{error}</SettingsNote> : null}

      {sync.connected || scheduled ? <Divider /> : null}
      {scheduled ? (
        <SettingsField label="Delete account">
          <View style={styles.notice}>
            <Icon name="alert" size={icon.sm} color={colors.danger} />
            <Text variant="caption" tone="secondary" style={styles.noticeText}>
              Your account will be deleted on {formatDay(scheduled)}. Sign in before then to keep it.
            </Text>
          </View>
        </SettingsField>
      ) : sync.connected ? (
        <SettingsField
          label="Delete account"
          help={sync.needsReauth ? "Your session expired. Sign in again to delete your account." : "Deleted after 30 days. Sign in before then to cancel."}
        >
          <View style={styles.actions}>
            <Button label="Delete account" variant="danger" disabled={sync.needsReauth} onPress={() => setDeleting(true)} />
          </View>
        </SettingsField>
      ) : null}

      {pending && summary ? (
        <ConfirmDialog
          portal
          title={pending.kind === "all" ? "Clear all data?" : `Clear ${pending.row.label.toLowerCase()}?`}
          message={
            <View style={styles.message}>
              <Text tone="secondary" style={styles.messageText}>
                {pending.kind === "all"
                  ? `Permanently deletes everything in your workspace ${where}, including AI agents, calendar accounts and exports.`
                  : `Permanently deletes ${pending.row.what(summary)} ${where}.`}
              </Text>
              {pending.kind === "row" && pending.row.note ? (
                <Text variant="caption" tone="tertiary">
                  {pending.row.note}
                </Text>
              ) : null}
              {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
            </View>
          }
          confirmLabel={pending.kind === "all" ? "Clear all data" : "Clear"}
          confirmText="delete"
          confirmTextPrompt="Type delete to confirm."
          onConfirm={() => clear(pending)}
          onClose={() => {
            setPending(null);
            setError(null);
          }}
        />
      ) : null}

      {deleting ? (
        <DeleteAccountDialog
          email={sync.email ?? ""}
          onClose={() => setDeleting(false)}
          onDeleted={(deletingAt) => {
            setDeleting(false);
            setScheduled(deletingAt);
          }}
        />
      ) : null}
    </View>
  );
}

/** Confirms account deletion with the account's password, which the server checks like a login
 *  (for an encrypted account, the auth key derived from it). */
function DeleteAccountDialog({ email, onClose, onDeleted }: { email: string; onClose: () => void; onDeleted: (deletingAt: string) => void }) {
  const sync = useSync();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    try {
      const { deletingAt } = await sync.deleteAccount(password);
      onDeleted(deletingAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const hints = useDialogKeys({ onEnter: () => void submit(), onEscape: busy ? undefined : onClose });

  return (
    <Dialog
      title="Delete account?"
      onClose={busy ? undefined : onClose}
      footer={
        <>
          <Button label="Cancel" variant="ghost" kbd={hints ? "esc" : undefined} disabled={busy} onPress={onClose} />
          <Button
            label={busy ? "…" : "Delete account"}
            variant="danger"
            kbd={hints ? "⏎" : undefined}
            disabled={busy || !password}
            onPress={() => void submit()}
          />
        </>
      }
    >
      <Text tone="secondary" style={styles.messageText}>
        Deletes {email || "your account"} and all its data in 30 days, and signs out every device now. Sign in before then to cancel.
      </Text>
      <SettingsNote>Data on this device stays until you clear it.</SettingsNote>
      <SettingsField label="Password">
        <Input
          autoFocus
          value={password}
          onChangeText={setPassword}
          onSubmitEditing={() => void submit()}
          placeholder="Password"
          secureTextEntry
          autoCapitalize="none"
        />
      </SettingsField>
      {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
    </Dialog>
  );
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "October 22, 2026" in the reader's locale. */
function formatDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

const styles = {
  section: { gap: space.xl },
  list: { borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radius.lg, overflow: "hidden" as const },
  row: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    paddingLeft: space.ml,
    paddingRight: space.sm,
    paddingVertical: space.xs,
    backgroundColor: colors.surfaceCard,
  },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.borderSubtle },
  rowLabel: { flex: 1 },
  actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.md, alignItems: "center" as const },
  notice: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.md,
    padding: space.md,
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.md,
  },
  noticeText: { flex: 1 },
  message: { gap: space.sm },
  messageText: { lineHeight: 19 },
};
