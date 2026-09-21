-- Scheduled exports: mirroring the workspace out to a folder or a Git repository on a schedule
-- (core/export).
--
-- A FOLDER destination is local-only: a path means nothing on another machine. A GIT destination
-- syncs (entity "git_export", core/domain/gitexport.go) so its repository, settings and — above
-- all — its credential are set up once for every device: the name, the config and credential_enc
-- are protected fields, sealed under the end-to-end encryption key on the wire, and the server
-- keeps the row as an opaque body. Without E2EE the credential stays out of the row, in this
-- device's secret store (credential_ref), so it never syncs in the clear — the same rule as
-- CalDAV passwords and agent API keys.
--
-- Only one device exports a Git destination (device_id): two devices with different sync states
-- pushing to one branch would fight. What a device did with a destination — its run state, and
-- the manifest — is that device's own and never leaves it.
--
-- (0028 is skipped on purpose: an abandoned migration used that number on development
-- databases, where a new 0028 would be recorded as already applied and never run.)

CREATE TABLE export_destinations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                  -- 'folder' | 'git'
  name TEXT NOT NULL DEFAULT '',
  -- folder: {"path"}; git: {"provider","auth","remoteUrl","branch","username","authorName",
  -- "authorEmail","publicKey","hostKey"}. Never a credential.
  config_json TEXT NOT NULL DEFAULT '{}',
  -- git: the access token, the password, or the SSH private key. In the row (plaintext here,
  -- enc$v1$ on the wire) when E2EE is unlocked; else in the secret store under credential_ref.
  credential_enc TEXT,
  credential_ref TEXT NOT NULL DEFAULT '',
  -- git: the device that runs this export, and its name for the others to show.
  device_id TEXT NOT NULL DEFAULT '',
  device_name TEXT NOT NULL DEFAULT '',
  schedule TEXT NOT NULL DEFAULT 'changes',  -- 'changes' | 'hourly' | 'daily' | 'weekly' | 'manual'
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,                    -- the last attempt, whatever came of it
  last_success_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  last_summary_json TEXT NOT NULL DEFAULT '',
  -- git: a commit was made locally but hasn't reached the remote yet (offline); retried.
  push_pending INTEGER NOT NULL DEFAULT 0,
  -- git: the commit this device last synced with — the base a two-way sync compares the fetched
  -- head against. The manifest describes the owned files as of this commit.
  base_commit TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Sync columns; only git rows are ever pushed.
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  dirty INTEGER NOT NULL DEFAULT 0
);

-- What each destination holds, so a run writes only real changes and knows which paths are its
-- own to delete (core/export.Diff). Emptying a destination's rows rebuilds it from scratch.
CREATE TABLE export_manifest (
  destination_id TEXT NOT NULL,
  path TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  content_sha TEXT NOT NULL,
  PRIMARY KEY (destination_id, path)
);
