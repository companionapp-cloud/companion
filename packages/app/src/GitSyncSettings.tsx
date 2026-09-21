import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Badge, Button, Icon, Input, Text, colors, radius, space } from "@companion/design-system";
import {
  EXPORT_CHANGED_EVENT,
  type ExportDestination,
  type ExportGitConfig,
  type ExportSchedule,
  type GitAuth,
  type GitProvider,
  type PendingSshKey,
} from "@companion/core-bridge";
import { useCore } from "./CoreContext";
import { useSync } from "./SyncProvider";
import { ConfirmDialog, useDialogKeys } from "./ConfirmDialog";
import { Dialog } from "./Dialog";
import { timeAgo } from "./NotificationRow";
import { CheckBox, CodeBlock, Segmented, SettingsField, SettingsNote } from "./settingsUi";
import { onScheduledExportRequest, takeScheduledExportRequest } from "./export/scheduling";

// ---- providers --------------------------------------------------------------------------

/** What differs between Git hosts: where repositories live, and what each way of signing in is
 *  called there and where to set it up. */
interface ProviderInfo {
  label: string;
  host: string;
  repoHint: string;
  token: string;
  ssh: string;
  https: string;
}

const PROVIDERS: Record<Exclude<GitProvider, "other">, ProviderInfo> = {
  github: {
    label: "GitHub",
    host: "github.com",
    repoHint: "you/companion-notes",
    token:
      "A fine-grained personal access token limited to this one repository, with Contents: Read and write. Create it under Settings › Developer settings › Personal access tokens › Fine-grained tokens.",
    ssh: "In the repository, open Settings › Deploy keys › Add deploy key, paste this key, and tick Allow write access.",
    https: "GitHub doesn’t accept your account password here. Enter your username, and a personal access token as the password.",
  },
  gitlab: {
    label: "GitLab",
    host: "gitlab.com",
    repoHint: "you/companion-notes",
    token:
      "A project access token with the write_repository scope and the Developer role (Maintainer if the branch is protected). Create it in the project under Settings › Access tokens.",
    ssh: "In the project, open Settings › Repository › Deploy keys, paste this key, and tick Grant write permissions to this key.",
    https: "Your GitLab username and password. With two-factor authentication on, GitLab needs a personal access token as the password instead.",
  },
  bitbucket: {
    label: "Bitbucket",
    host: "bitbucket.org",
    repoHint: "workspace/companion-notes",
    token: "A repository access token with Repositories: Write. Create it in the repository under Repository settings › Access tokens.",
    ssh:
      "Bitbucket’s repository access keys are read-only, so add this key to your own account instead — Personal settings › SSH keys. It can then reach every repository you can, not just this one.",
    https: "Your Bitbucket username (not your email) and an app password or API token with repository write access.",
  },
};

const PROVIDER_OPTIONS: { value: GitProvider; label: string }[] = [
  { value: "github", label: "GitHub" },
  { value: "gitlab", label: "GitLab" },
  { value: "bitbucket", label: "Bitbucket" },
  { value: "other", label: "Other" },
];

const AUTH_OPTIONS: { value: GitAuth; label: string }[] = [
  { value: "token", label: "Access token" },
  { value: "ssh", label: "SSH key" },
  { value: "https", label: "Password" },
];

const SCHEDULES: { value: ExportSchedule; label: string }[] = [
  { value: "changes", label: "On changes" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "manual", label: "Manually" },
];

const SCHEDULE_WORDS: Record<ExportSchedule, string> = {
  changes: "as things change",
  hourly: "every hour",
  daily: "every day",
  weekly: "every week",
  manual: "only when asked",
};

/** The remote for a repository on a known host: `owner/name` (a pasted URL is taken apart
 *  first), as the https or the SSH address the way of signing in needs. */
export function remoteFor(provider: GitProvider, auth: GitAuth, repository: string): string {
  const typed = repository.trim();
  if (provider === "other") return typed;
  const path = repoPath(typed);
  if (!path) return "";
  const { host } = PROVIDERS[provider];
  return auth === "ssh" ? `git@${host}:${path}.git` : `https://${host}/${path}.git`;
}

/** `owner/name` out of whatever was typed or stored: a bare path, an https URL, or an SSH one. */
export function repoPath(input: string): string {
  let s = input.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  s = s.replace(/^[a-z]+:\/\/([^@/]+@)?[^/]+\//i, "").replace(/^[^@\s/]+@[^:/]+:/, "");
  return /^[^\s/]+(\/[^\s/]+)+$/.test(s) ? s : "";
}

// ---- settings section -------------------------------------------------------------------

type Editing = { destination?: ExportDestination } | null;

/** Settings › Sync › Git: keep the workspace in a Git repository, both ways. Notes and tasks are
 *  markdown files, canvases JSON; what changes in Companion is committed and pushed, and what
 *  changes in the repository — edits made in another editor, on another machine, by a script —
 *  comes back in. The core does the syncing (core/export/gitsink); one device runs each sync,
 *  and the rest hold its settings, ready to take over. */
export function GitSyncSettings() {
  const { core, exports } = useCore();
  const sync = useSync();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [destinations, setDestinations] = useState<ExportDestination[]>([]);
  const [editing, setEditing] = useState<Editing>(null);

  const refresh = useCallback(() => {
    void exports
      .list()
      .then((all) => setDestinations(all.filter((d) => d.kind === "git")))
      .catch(() => setDestinations([]));
  }, [exports]);
  useEffect(() => {
    void exports
      .capabilities()
      .then((c) => setAvailable(c.git))
      .catch(() => setAvailable(false));
    refresh();
    const offExport = core.on(EXPORT_CHANGED_EVENT, refresh);
    // A Git sync set up or changed on another device arrives with a server sync.
    const offData = core.on("data.changed", (payload) => {
      if (!(payload as { id?: string } | null)?.id) refresh();
    });
    return () => {
      offExport();
      offData();
    };
  }, [core, exports, refresh]);

  // File › Export › Git Sync… lands here.
  useEffect(() => {
    const take = () => {
      if (takeScheduledExportRequest("git")) setEditing({});
    };
    take();
    return onScheduledExportRequest(take);
  }, []);

  if (available === null) return null;
  return (
    <View style={styles.section}>
      <View style={styles.head}>
        <Text variant="eyebrow" tone="quaternary">
          Git
        </Text>
        <SettingsNote>
          Keep your workspace in a Git repository, both ways: notes and tasks as Markdown, canvases as JSON, attachments beside
          them, a commit whenever something changes. Edit the files anywhere — another editor, another machine, a script — and the changes come back
          into Companion.
        </SettingsNote>
      </View>
      {destinations.map((d) => (
        <GitRow
          key={d.id}
          destination={d}
          canRun={available}
          onRun={(force) => void exports.run(d.id, force)}
          onTakeOver={() => void exports.takeOver(d.id).then(() => sync.trigger())}
          onEdit={() => setEditing({ destination: d })}
        />
      ))}
      {available ? (
        <View style={styles.buttonRow}>
          <Button label="Set up Git sync…" variant="secondary" onPress={() => setEditing({})} />
        </View>
      ) : (
        <SettingsNote tone="secondary">
          Git sync runs in the Companion desktop app. {destinations.length ? "These are set up there." : "Set it up there, under Settings › Sync."}
        </SettingsNote>
      )}
      <SettingsNote>
        The repository holds plain, readable files, so it sits outside Companion’s end-to-end encryption: anyone who can read it
        can read your notes, and anyone who can write to it can change them. Deleting a file there moves its note to the Trash.{" "}
        {sync.encrypted
          ? "The repository’s address and sign-in are synced to your other devices end-to-end encrypted, so any of them can take the sync over."
          : "Because this account isn’t end-to-end encrypted, the sign-in stays on this device and isn’t synced."}
      </SettingsNote>
      {editing ? (
        <GitDialog
          destination={editing.destination}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            sync.trigger();
          }}
        />
      ) : null}
    </View>
  );
}

function statusOf(d: ExportDestination): { text: string; tone: "tertiary" | "danger" } {
  if (d.running) return { text: "Syncing…", tone: "tertiary" };
  if (d.lastError) return { text: d.lastError, tone: "danger" };
  if (!d.lastSuccessAt) return { text: d.enabled ? "Not synced yet" : "Paused", tone: "tertiary" };
  const s = d.lastSummary;
  const sent = s ? s.added + s.updated + s.removed : 0;
  const parts = [
    sent ? `${sent} sent` : "",
    s?.pulled ? `${s.pulled} received` : "",
    s?.trashed ? `${s.trashed} moved to Trash` : "",
    s?.conflicts ? `${s.conflicts} kept as conflicted ${s.conflicts === 1 ? "copy" : "copies"}` : "",
    s?.unread ? `${s.unread} couldn’t be read` : "",
    s?.waiting ? `${s.waiting} ${s.waiting === 1 ? "attachment" : "attachments"} still downloading` : "",
    s?.tooLarge ? `${s.tooLarge} ${s.tooLarge === 1 ? "attachment is" : "attachments are"} too large for Git` : "",
  ].filter(Boolean);
  return { text: `Synced ${timeAgo(d.lastSuccessAt)} · ${parts.length ? parts.join(", ") : "up to date"}`, tone: "tertiary" };
}

function GitRow({
  destination: d,
  canRun,
  onRun,
  onTakeOver,
  onEdit,
}: {
  destination: ExportDestination;
  canRun: boolean;
  onRun: (force: boolean) => void;
  onTakeOver: () => void;
  onEdit: () => void;
}) {
  const config = d.config as ExportGitConfig;
  const status = statusOf(d);
  // The core pauses a sync that would bin a large share of the workspace, and says so.
  const paused = !!d.lastError && d.lastError.includes("were deleted there");
  return (
    <View style={styles.row}>
      <View style={styles.rowHead}>
        <Icon name="code" size={13} color={colors.textTertiary} />
        <Text variant="label" numberOfLines={1} style={{ flexShrink: 1 }}>
          {d.name}
        </Text>
        {!d.enabled ? <Badge tone="neutral" label="paused" /> : null}
        {!d.thisDevice ? <Badge tone="info" label={`on ${d.deviceName || "another device"}`} /> : null}
        <View style={{ flex: 1 }} />
        {d.thisDevice && canRun ? (
          <>
            {paused ? <Button label="Sync anyway" variant="ghost" size="sm" disabled={d.running} onPress={() => onRun(true)} /> : null}
            <Button label={d.running ? "Syncing…" : "Sync now"} variant="ghost" size="sm" disabled={d.running} onPress={() => onRun(false)} />
          </>
        ) : null}
        {canRun ? <Button label="Edit" variant="ghost" size="sm" onPress={onEdit} /> : null}
      </View>
      <Text variant="mono" tone="tertiary" numberOfLines={1}>
        {config.remoteUrl} · {config.branch}
      </Text>
      {d.thisDevice ? (
        <Text variant="caption" tone={status.tone} numberOfLines={4}>
          {d.enabled ? `Syncs ${SCHEDULE_WORDS[d.schedule]}` : "Paused"} · {status.text}
        </Text>
      ) : (
        <>
          <Text variant="caption" tone="tertiary">
            {d.deviceName || "Another device"} runs this sync; this one only holds its settings.
            {d.hasCredential ? "" : " Its sign-in isn’t on this device — to sync from here, edit it and sign in again."}
          </Text>
          {canRun && d.hasCredential ? (
            <View style={styles.buttonRow}>
              <Button label="Sync from this computer instead" variant="secondary" size="sm" onPress={onTakeOver} />
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

// ---- dialog -----------------------------------------------------------------------------

function GitDialog({ destination, onClose, onSaved }: { destination?: ExportDestination; onClose: () => void; onSaved: () => void }) {
  const { exports } = useCore();
  const existing = destination?.config as ExportGitConfig | undefined;
  const [provider, setProvider] = useState<GitProvider>(existing?.provider ?? "github");
  const [auth, setAuth] = useState<GitAuth>(existing?.auth ?? "token");
  const [repository, setRepository] = useState(existing ? (existing.provider === "other" ? existing.remoteUrl : repoPath(existing.remoteUrl)) : "");
  const [branch, setBranch] = useState(existing?.branch ?? "main");
  const [username, setUsername] = useState(existing?.username ?? "");
  const [secret, setSecret] = useState("");
  const [name, setName] = useState(destination?.name ?? "");
  const [authorName, setAuthorName] = useState(existing?.authorName ?? "");
  const [authorEmail, setAuthorEmail] = useState(existing?.authorEmail ?? "");
  const [schedule, setSchedule] = useState<ExportSchedule>(destination?.schedule ?? "changes");
  const [enabled, setEnabled] = useState(destination?.enabled ?? true);
  const [more, setMore] = useState(false);
  const [sshKey, setSshKey] = useState<PendingSshKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const info = provider === "other" ? null : PROVIDERS[provider];
  // The stored credential still applies while the way of signing in is unchanged.
  const keepsCredential = !!destination?.hasCredential && existing?.auth === auth;
  const publicKey = sshKey?.publicKey ?? (existing?.auth === "ssh" ? existing.publicKey : undefined);

  // A generated key that no save adopts is thrown away, whichever way the dialog goes.
  const pending = useRef<string | null>(null);
  const adopted = useRef(false);
  useEffect(
    () => () => {
      if (pending.current && !adopted.current) void exports.discardSshKey(pending.current);
    },
    [exports],
  );
  const generate = useCallback(async () => {
    setError(null);
    try {
      if (pending.current) void exports.discardSshKey(pending.current);
      const key = await exports.generateSshKey();
      pending.current = key.keyId;
      setSshKey(key);
      setCopied(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [exports]);
  // Choosing SSH makes the key straight away: adding it to the host is the next thing to do.
  useEffect(() => {
    if (auth === "ssh" && !publicKey && !pending.current) void generate();
  }, [auth, publicKey, generate]);

  const input = () => ({
    id: destination?.id,
    kind: "git" as const,
    provider,
    auth,
    remoteUrl: remoteFor(provider, auth, repository),
    branch: branch.trim(),
    username: auth === "https" || provider === "other" ? username.trim() : "",
    token: auth === "ssh" ? "" : secret,
    sshKeyId: auth === "ssh" ? sshKey?.keyId : undefined,
    name: name.trim(),
    authorName: authorName.trim(),
    authorEmail: authorEmail.trim(),
    schedule,
    enabled,
  });

  const validate = (): string | null => {
    if (!remoteFor(provider, auth, repository)) return info ? `Enter the repository as ${info.repoHint}.` : "Enter the repository’s address.";
    if (auth === "https" && !username.trim()) return "Enter the username.";
    if (auth !== "ssh" && !secret && !keepsCredential) return auth === "token" ? "Enter the access token." : "Enter the password.";
    return null;
  };

  const test = async () => {
    const problem = validate();
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    setChecked(null);
    try {
      const res = await exports.check(input());
      if (res.ok) setChecked("Companion can reach the repository.");
      else setError(res.error ?? "Couldn’t reach the repository.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const save = async () => {
    if (busy) return;
    const problem = validate();
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await exports.save(input());
      adopted.current = true;
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!publicKey) return;
    try {
      await navigator.clipboard.writeText(publicKey);
      setCopied(true);
    } catch {
      setError("Couldn’t copy — select the key and copy it by hand.");
    }
  };

  const hints = useDialogKeys({ onEnter: () => void save(), onEscape: busy ? undefined : onClose });

  if (confirmDelete && destination) {
    return (
      <ConfirmDialog
        title="Stop syncing with this repository?"
        message={`Companion forgets “${destination.name}” on all your devices and removes its sign-in. The repository and its history stay exactly as they are, and so does everything in Companion.`}
        confirmLabel="Stop syncing"
        onConfirm={async () => {
          await exports.remove(destination.id);
          onSaved();
        }}
        onClose={() => setConfirmDelete(false)}
      />
    );
  }

  return (
    <Dialog
      title={destination ? "Edit Git sync" : "Set up Git sync"}
      width={500}
      onClose={busy ? undefined : onClose}
      footer={
        <>
          {destination ? <Button label="Stop syncing…" variant="danger" onPress={() => setConfirmDelete(true)} /> : null}
          <View style={{ flex: 1 }} />
          <Button label="Cancel" variant="ghost" kbd={hints ? "esc" : undefined} onPress={onClose} />
          <Button label={busy ? "Working…" : destination ? "Save" : "Start syncing"} kbd={hints ? "⏎" : undefined} disabled={busy} onPress={() => void save()} />
        </>
      }
    >
      <SettingsField label="Where is the repository?">
        <Segmented fill options={PROVIDER_OPTIONS} value={provider} onChange={(p) => (setProvider(p), setChecked(null), setError(null))} />
      </SettingsField>
      <SettingsField label="Sign in with">
        <Segmented fill options={AUTH_OPTIONS} value={auth} onChange={(a) => (setAuth(a), setSecret(""), setChecked(null), setError(null))} />
      </SettingsField>

      <SettingsField
        label="Repository"
        help={
          info
            ? "A repository just for this, ideally empty and private. Companion keeps its files in Notes, Tasks, Canvases and Areas folders and leaves everything else alone."
            : auth === "ssh"
              ? "The repository’s SSH address."
              : "The repository’s https:// address."
        }
      >
        <Input
          mono
          autoFocus={!destination}
          value={repository}
          onChangeText={setRepository}
          placeholder={info ? info.repoHint : auth === "ssh" ? "git@git.example.com:you/companion-notes.git" : "https://git.example.com/you/companion-notes.git"}
          autoCapitalize="none"
        />
      </SettingsField>

      {auth === "token" ? (
        <SettingsField label="Access token" help={info?.token ?? "A token that can write to this repository. It’s sent as the password; set a username under More options if your server wants a particular one."}>
          <Input value={secret} onChangeText={setSecret} secureTextEntry autoCapitalize="none" placeholder={keepsCredential ? "Stored — leave blank to keep it" : ""} />
        </SettingsField>
      ) : null}
      {auth === "token" && /^(ghp_|gho_)/.test(secret) ? (
        <SettingsNote tone="danger">
          That looks like a classic GitHub token, which can reach every repository you can. A fine-grained token limited to this
          repository is much safer.
        </SettingsNote>
      ) : null}

      {auth === "https" ? (
        <>
          {info ? <SettingsNote>{info.https}</SettingsNote> : null}
          <SettingsField label="Username">
            <Input value={username} onChangeText={setUsername} autoCapitalize="none" />
          </SettingsField>
          <SettingsField label="Password">
            <Input value={secret} onChangeText={setSecret} secureTextEntry autoCapitalize="none" placeholder={keepsCredential ? "Stored — leave blank to keep it" : ""} />
          </SettingsField>
        </>
      ) : null}

      {auth === "ssh" ? (
        <SettingsField
          label="Deploy key"
          help={info?.ssh ?? "Add this public key to the repository as a deploy key with write access. Companion keeps the private half and never shows it."}
        >
          {publicKey ? <CodeBlock>{publicKey}</CodeBlock> : <SettingsNote>Making a key…</SettingsNote>}
          <View style={styles.inline}>
            <Button label={copied ? "Copied" : "Copy key"} variant="secondary" size="sm" disabled={!publicKey} onPress={() => void copy()} />
            {destination && existing?.auth === "ssh" ? <Button label="Make a new key" variant="ghost" size="sm" onPress={() => void generate()} /> : null}
          </View>
          {sshKey && existing?.auth === "ssh" ? <SettingsNote>The new key replaces the old one when you save; remove the old one from the host afterwards.</SettingsNote> : null}
        </SettingsField>
      ) : null}

      <View style={styles.inline}>
        <Button label={busy ? "Checking…" : "Test connection"} variant="secondary" size="sm" disabled={busy} onPress={() => void test()} />
        <Button label={more ? "Fewer options" : "More options"} variant="ghost" size="sm" onPress={() => setMore((v) => !v)} />
      </View>

      {more ? (
        <>
          <SettingsField label="Branch">
            <Input mono value={branch} onChangeText={setBranch} placeholder="main" autoCapitalize="none" />
          </SettingsField>
          {provider === "other" && auth === "token" ? (
            <SettingsField label="Username" help="Only if your server wants a particular one beside the token.">
              <Input value={username} onChangeText={setUsername} autoCapitalize="none" />
            </SettingsField>
          ) : null}
          <SettingsField label="Sync" help={schedule === "changes" ? "About a minute after you stop making changes, and every few minutes to pick up changes made in the repository." : schedule === "manual" ? "Only when you choose Sync now." : undefined}>
            <Segmented fill options={SCHEDULES} value={schedule} onChange={setSchedule} />
          </SettingsField>
          <SettingsField label="Name" help="Optional. The repository’s name otherwise.">
            <Input value={name} onChangeText={setName} />
          </SettingsField>
          <SettingsField label="Commit author" help="Optional. Who Companion’s commits are from.">
            <View style={styles.inline}>
              <View style={{ flex: 1 }}>
                <Input value={authorName} onChangeText={setAuthorName} placeholder="Name" />
              </View>
              <View style={{ flex: 1 }}>
                <Input value={authorEmail} onChangeText={setAuthorEmail} placeholder="Email" autoCapitalize="none" />
              </View>
            </View>
          </SettingsField>
        </>
      ) : null}
      {destination ? <CheckBox checked={enabled} onPress={() => setEnabled((v) => !v)} label="Keep syncing" /> : null}

      {checked ? <SettingsNote tone="secondary">{checked}</SettingsNote> : null}
      {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
    </Dialog>
  );
}

const styles = {
  section: { gap: space.md, marginTop: space.xxl },
  head: { gap: space.xs },
  buttonRow: { flexDirection: "row" as const },
  inline: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm },
  row: {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radius.lg,
    paddingLeft: space.ml,
    paddingRight: space.xs,
    paddingTop: space.xs,
    paddingBottom: space.sm,
    gap: 2,
  },
  rowHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm },
};
