import type { CoreBridge } from "./types";

// Files outside the app (core/export, core/bridge/export.go): notes and tasks as markdown with
// front matter, canvases as JSON, and the files they embed in an Attachments folder.
//
//  - A FOLDER destination is a one-way export, kept up to date on a schedule. It belongs to the
//    device that set it up.
//  - A GIT destination is a two-way sync: what changes in the repository comes back in. It syncs
//    between devices — repository, settings and credential, the credential end-to-end encrypted
//    — but only one device, its exporter, ever runs it; the others can take it over.
//  - Importing a folder of files is a separate, one-time act (importFilesApi).

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
  config: ExportFolderConfig | ExportGitConfig;
  schedule: ExportSchedule;
  enabled: boolean;
  /** The last attempt, however it went. */
  lastRunAt?: string | null;
  lastSuccessAt?: string | null;
  lastError?: string;
  lastSummary?: ExportSummary | null;
  pushPending: boolean;
  /** Git: this device can sign in. False when the export synced here without its credential —
   *  an account without end-to-end encryption keeps it on the device it was typed into. The
   *  credential itself never crosses the bridge. */
  hasCredential: boolean;
  /** This device is the one that runs it (always, for a folder). */
  thisDevice: boolean;
  /** Git: the device that runs it, for the others to show. */
  deviceId?: string;
  deviceName?: string;
  running: boolean;
  createdAt: string;
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
    /** Make this device the one that runs a Git sync. */
    takeOver: (id: string) => core.invoke<ExportDestination>("export.destinations.takeOver", { id }),
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
