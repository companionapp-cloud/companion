import type { CoreBridge } from "./types";

// Files outside the app (core/export, core/bridge/export.go): notes and tasks as markdown with
// front matter, canvases as JSON, and the files they embed in an Attachments folder.
//
//  - A FOLDER destination is a one-way export, kept up to date on a schedule, into a folder on
//    one device's disk.
//  - A GIT destination is a two-way sync: what changes in the repository comes back in. Its
//    repository, settings and credential travel between devices, the credential end-to-end
//    encrypted.
//  - Importing a folder of files is a separate, one-time act (importFilesApi).
//
// Both kinds sync, and only one device, the exporter, ever runs each. Every other device lists
// it with the exporter's name and how its last run went, and can pause, resume or remove it (the
// exporter picks that up the next time it syncs) or, where exports can run, take it over.

export type ExportKind = "folder" | "git";
/** "changes": shortly after anything changes. "manual": only when asked. */
export type ExportSchedule = "changes" | "hourly" | "daily" | "weekly" | "manual";

export interface ExportFolderConfig {
  path: string;
}

export type GitProvider = "github" | "gitlab" | "bitbucket" | "other";
/** How Companion signs in: an access token or a username and password over HTTPS, or an SSH
 *  deploy key Companion generates. */
export type GitAuth = "token" | "https" | "ssh";

export interface ExportGitConfig {
  provider: GitProvider;
  auth: GitAuth;
  remoteUrl: string;
  branch: string;
  username?: string;
  authorName?: string;
  authorEmail?: string;
  /** SSH: the public half of the deploy key, to add to the Git host. */
  publicKey?: string;
  /** SSH: the host key pinned on first contact. */
  hostKey?: string;
}

/** What the last run did: files written out and, for a Git sync, what came back in. */
export interface ExportSummary {
  added: number;
  updated: number;
  removed: number;
  /** Git: items created or updated from changes made in the repository. */
  pulled?: number;
  /** Git: items moved to the Trash because their files were deleted there. */
  trashed?: number;
  /** Git: items changed on both sides — the repository's version taken, Companion's kept as a copy. */
  conflicts?: number;
  /** Git: changed files that couldn't be read, and were left as they are. */
  unread?: number;
  /** Attachments whose bytes aren't on this device yet; they go out on a later run. */
  waiting?: number;
  /** Git: attachments over the size Git hosts take (50 MB), which stay out of the repository. */
  tooLarge?: number;
}

export interface ExportDestination {
  id: string;
  kind: ExportKind;
  name: string;
  /** A folder export's path is on its exporter's disk. */
  config: ExportFolderConfig | ExportGitConfig;
  schedule: ExportSchedule;
  enabled: boolean;
  /** The last attempt, however it went. On another device's export, this and the next two are
   *  what its exporter last reported: after a run that changed something or failed, and at
   *  least hourly while it's running. */
  lastRunAt?: string | null;
  lastSuccessAt?: string | null;
  lastError?: string;
  /** This device's own runs only. */
  lastSummary?: ExportSummary | null;
  pushPending: boolean;
  /** Git: this device can sign in. False when the export synced here without its credential —
   *  an account without end-to-end encryption keeps it on the device it was typed into. The
   *  credential itself never crosses the bridge. */
  hasCredential: boolean;
  /** This device is the one that runs it. */
  thisDevice: boolean;
  /** The device that runs it, and what the others call it. */
  deviceId?: string;
  deviceName?: string;
  /** Another device's export: whether that device is online now, and when it last synced.
   *  Unset when nothing is known of it (no server, or it hasn't registered). */
  ownerOnline?: boolean;
  ownerLastSeenAt?: string | null;
  /** Another device's export whose settings changed after that device last synced: it hasn't
   *  picked the change up yet, so a pause, say, hasn't taken effect. */
  pending?: boolean;
  running: boolean;
  createdAt: string;
  /** When the settings last changed (a run's report never moves it). */
  updatedAt: string;
}

export interface SaveExportInput {
  /** Omit to create. */
  id?: string;
  kind: ExportKind;
  name?: string;
  schedule?: ExportSchedule;
  enabled?: boolean;
  /** folder */
  path?: string;
  /** git */
  provider?: GitProvider;
  auth?: GitAuth;
  remoteUrl?: string;
  branch?: string;
  username?: string;
  authorName?: string;
  authorEmail?: string;
  /** Write-only: a new access token, or password, to store. Empty keeps the stored one. */
  token?: string;
  /** SSH: a key from `generateSshKey` for this destination to adopt. Empty keeps its own. */
  sshKeyId?: string;
}

/** A freshly generated deploy key, waiting for a save to adopt it. */
export interface PendingSshKey {
  keyId: string;
  publicKey: string;
}

/** Which kinds this device can run. Both false in the browser and on phones, for now. */
export interface ExportCapabilities {
  folder: boolean;
  git: boolean;
}

/** Emitted when a destination is saved or deleted, and when a run starts or ends. */
export const EXPORT_CHANGED_EVENT = "export.changed";

export function exportsApi(core: CoreBridge) {
  return {
    capabilities: () => core.invoke<ExportCapabilities>("export.capabilities"),
    list: () => core.invoke<ExportDestination[]>("export.destinations.list"),
    /** Create or update. A newly enabled destination runs straight away. */
    save: (input: SaveExportInput) => core.invoke<ExportDestination>("export.destinations.save", input),
    /** Forget the destination. What it exported stays where it is. */
    remove: (id: string) => core.invoke<{ ok: boolean }>("export.destinations.delete", { id }),
    /** Run now, in the background; progress arrives as `export.changed`. `force` confirms a Git
     *  sync that paused itself because a large share of its files were deleted in the repository. */
    run: (id: string, force = false) => core.invoke<{ started: boolean }>("export.destinations.run", { id, force }),
    /** Try a Git remote with a credential before saving it. */
    check: (input: SaveExportInput) => core.invoke<{ ok: boolean; error?: string }>("export.destinations.check", input),
    /** Make this device the one that runs an export, and start it if it was paused. A folder
     *  export needs the folder on this device (`path`); a Git sync, the sign-in. The device that
     *  ran it stops the next time it syncs. */
    takeOver: (id: string, path?: string) => core.invoke<ExportDestination>("export.destinations.takeOver", { id, path }),
    /** Pause or resume an export, from any device: another device's export stops or starts the
     *  next time that device syncs (`pending` until then). */
    setEnabled: (id: string, enabled: boolean) => core.invoke<ExportDestination>("export.destinations.setEnabled", { id, enabled }),
    /** Make an SSH deploy key. The private half stays in the core; save with its `keyId`. */
    generateSshKey: () => core.invoke<PendingSshKey>("export.sshKey.generate"),
    /** Throw away a generated key that no save adopted (a cancelled dialog). */
    discardSshKey: (keyId: string) => core.invoke<{ ok: boolean }>("export.sshKey.discard", { keyId }),
  };
}

/** Emitted by the core when it needs a server sync before it goes on (a Git sync never runs on
 *  stale data). The shell's sync provider answers — only it knows whether an end-to-end encrypted
 *  account is unlocked. */
export const SYNC_REQUESTED_EVENT = "sync.requested";

// ---- one-time file import (core/importer/files) -----------------------------------------

export interface FileImportOutcome {
  path: string;
  type?: "note" | "task" | "canvas";
  title?: string;
  action: "created" | "updated" | "skipped" | "failed";
  reason?: string;
}

export interface FileImportReport {
  root: string;
  files: number;
  summary: { notes: number; tasks: number; canvases: number; attachments: number; created: number; updated: number; skipped: number; failed: number };
  /** The files that were skipped or failed, capped at 100; the counts are complete. */
  problems: FileImportOutcome[];
}

/** Importing a folder of markdown and canvas files — a Companion export, an Obsidian vault, any
 *  folder of notes. Explicit and one-time: it adds (or, asked to, updates) and never deletes. */
export function importFilesApi(core: CoreBridge) {
  return {
    /** What importing the folder would do, without doing it. */
    scan: (path: string, updateExisting = false) => core.invoke<FileImportReport>("imports.files.scan", { path, updateExisting }),
    run: (path: string, updateExisting = false) => core.invoke<FileImportReport>("imports.files.run", { path, updateExisting }),
  };
}

export type ImportFilesApi = ReturnType<typeof importFilesApi>;

export type ExportsApi = ReturnType<typeof exportsApi>;
