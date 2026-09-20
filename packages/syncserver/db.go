package syncserver

import (
	"database/sql"
	"fmt"
	"strconv"
	"strings"

	_ "github.com/jackc/pgx/v5/stdlib" // Postgres (production, PLAN §4.2)
	_ "modernc.org/sqlite"             // SQLite (dev + fast headless tests)
)

// schema is the server store. It mirrors the client's business columns but adds
// multi-tenancy (user_id) and a per-user monotonic server_seq for cheap, idempotent
// pulls (PLAN §4.2). The types (TEXT / BIGINT / BYTEA) and `ON CONFLICT … EXCLUDED`
// upserts are valid on both Postgres and SQLite; timestamps are stored as RFC3339
// text, matching the client and wire format.
const schema = `
CREATE TABLE IF NOT EXISTS users (
  id                        TEXT PRIMARY KEY,
  email                     TEXT UNIQUE NOT NULL,
  password_hash             TEXT NOT NULL,
  first_name                TEXT NOT NULL DEFAULT '',
  last_name                 TEXT NOT NULL DEFAULT '',
  email_verified_at         TEXT,             -- NULL until the address is confirmed
  password_reset_token      TEXT,             -- rotated on each forgot-password request
  password_reset_expires_at TEXT,
  created_at                TEXT NOT NULL
);

-- One-time email verification tokens. The email is captured at issue time so a later
-- address change invalidates in-flight tokens (they'd verify a stale address).
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  email      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_verification_user ON email_verification_tokens (user_id);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_seq (
  user_id TEXT PRIMARY KEY,
  seq     BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS notes (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  title          TEXT NOT NULL DEFAULT '',
  content_md     TEXT NOT NULL DEFAULT '',
  date           TEXT,
  object_type_id TEXT,                          -- archetype (PLAN §6.3); NULL = plain note
  props_json     TEXT NOT NULL DEFAULT '{}',    -- schema-validated structured metadata
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleting_at    TEXT,                          -- Trash: due-to-be-purged instant (PLAN §4.3)
  deleted_at     TEXT,
  version        BIGINT NOT NULL DEFAULT 1,
  server_seq     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_user_seq ON notes (user_id, server_seq);

CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  title          TEXT NOT NULL DEFAULT '',
  notes_md       TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'open',
  start_at       TEXT,
  due_at         TEXT,                          -- the deadline (PLAN §6.4)
  reminders_json TEXT NOT NULL DEFAULT '[]',    -- [{"at":…}|{"before":lead}] (PLAN §6.4)
  remind_at      TEXT,                          -- legacy single reminder: moved into reminders_json by migrate, never written
  completed_at   TEXT,
  repeat_rule    TEXT,
  repeat_seed_id TEXT,
  object_type_id TEXT,
  props_json     TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleting_at    TEXT,
  deleted_at     TEXT,
  version        BIGINT NOT NULL DEFAULT 1,
  server_seq     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_user_seq ON tasks (user_id, server_seq);
-- One occurrence per (seed, due instant): a safety net behind the materializer's own
-- idempotency (PLAN §6.4). NULL repeat_seed_id rows (seeds, one-offs) are distinct under
-- SQL NULL semantics, so non-occurrence tasks are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_occurrence ON tasks (repeat_seed_id, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_seed ON tasks (user_id, repeat_seed_id);

CREATE TABLE IF NOT EXISTS documents (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  filename      TEXT NOT NULL,
  mime          TEXT NOT NULL DEFAULT 'application/octet-stream',
  size          BIGINT NOT NULL DEFAULT 0,
  sha256        TEXT NOT NULL,                 -- content address; bytes live in object storage
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleting_at   TEXT,                          -- Trash (PLAN §4.3)
  deleted_at    TEXT,
  version       BIGINT NOT NULL DEFAULT 1,
  server_seq    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_user_seq ON documents (user_id, server_seq);
CREATE INDEX IF NOT EXISTS idx_documents_user_sha ON documents (user_id, sha256);

CREATE TABLE IF NOT EXISTS object_types (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  name           TEXT NOT NULL,
  applies_to     TEXT NOT NULL,
  schema_version BIGINT NOT NULL DEFAULT 1,
  schema_json    TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  version        BIGINT NOT NULL DEFAULT 1,
  server_seq     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_object_types_user_seq ON object_types (user_id, server_seq);

CREATE TABLE IF NOT EXISTS areas (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  color      TEXT,
  icon       TEXT,
  cover_document_id TEXT,
  description_md    TEXT NOT NULL DEFAULT '',
  sort_order BIGINT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version    BIGINT NOT NULL DEFAULT 1,
  server_seq BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_areas_user_seq ON areas (user_id, server_seq);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  area_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  color       TEXT,
  icon        TEXT,
  cover_document_id TEXT,
  description_md    TEXT NOT NULL DEFAULT '',
  sort_order  BIGINT NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  version     BIGINT NOT NULL DEFAULT 1,
  server_seq  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_user_seq ON projects (user_id, server_seq);

CREATE TABLE IF NOT EXISTS project_members (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  container_type TEXT NOT NULL DEFAULT 'project',
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  version     BIGINT NOT NULL DEFAULT 1,
  server_seq  BIGINT NOT NULL,
  UNIQUE (project_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_project_members_user_seq ON project_members (user_id, server_seq);

CREATE TABLE IF NOT EXISTS lists (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  sort_order  BIGINT NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  version     BIGINT NOT NULL DEFAULT 1,
  server_seq  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lists_user_seq ON lists (user_id, server_seq);

CREATE TABLE IF NOT EXISTS list_items (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  list_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  task_id     TEXT,
  title       TEXT NOT NULL DEFAULT '',
  sort_order  BIGINT NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  version     BIGINT NOT NULL DEFAULT 1,
  server_seq  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_list_items_user_seq ON list_items (user_id, server_seq);

CREATE TABLE IF NOT EXISTS canvases (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleting_at TEXT,
  deleted_at  TEXT,
  version     BIGINT NOT NULL DEFAULT 1,
  server_seq  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_canvases_user_seq ON canvases (user_id, server_seq);

CREATE TABLE IF NOT EXISTS canvas_nodes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  canvas_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  x          DOUBLE PRECISION NOT NULL DEFAULT 0,
  y          DOUBLE PRECISION NOT NULL DEFAULT 0,
  width      DOUBLE PRECISION NOT NULL DEFAULT 200,
  height     DOUBLE PRECISION NOT NULL DEFAULT 100,
  z          BIGINT NOT NULL DEFAULT 0,
  color      TEXT,
  ref_type   TEXT,
  ref_id     TEXT,
  data_json  TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version    BIGINT NOT NULL DEFAULT 1,
  server_seq BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_canvas_nodes_user_seq ON canvas_nodes (user_id, server_seq);
CREATE INDEX IF NOT EXISTS idx_canvas_nodes_canvas ON canvas_nodes (canvas_id);

CREATE TABLE IF NOT EXISTS canvas_edges (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  canvas_id    TEXT NOT NULL,
  from_node_id TEXT NOT NULL,
  to_node_id   TEXT NOT NULL,
  from_side    TEXT,
  to_side      TEXT,
  from_end     TEXT NOT NULL DEFAULT 'none',
  to_end       TEXT NOT NULL DEFAULT 'arrow',
  style        TEXT NOT NULL DEFAULT 'curved',
  label        TEXT NOT NULL DEFAULT '',
  color        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  version      BIGINT NOT NULL DEFAULT 1,
  server_seq   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_canvas_edges_user_seq ON canvas_edges (user_id, server_seq);
CREATE INDEX IF NOT EXISTS idx_canvas_edges_canvas ON canvas_edges (canvas_id);

-- Note ink (PLAN-drawing.md): one row per ink group drawn over a note. data_json is an
-- encrypted envelope on an encrypted account; note_id stays plaintext for the purge cascade.
CREATE TABLE IF NOT EXISTS note_ink (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  note_id    TEXT NOT NULL,
  data_json  TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version    BIGINT NOT NULL DEFAULT 1,
  server_seq BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_note_ink_user_seq ON note_ink (user_id, server_seq);
CREATE INDEX IF NOT EXISTS idx_note_ink_note ON note_ink (note_id);

CREATE TABLE IF NOT EXISTS chats (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  config_id  TEXT,
  model      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version    BIGINT NOT NULL DEFAULT 1,
  server_seq BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chats_user_seq ON chats (user_id, server_seq);

CREATE TABLE IF NOT EXISTS chat_messages (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  chat_id      TEXT NOT NULL,
  seq          BIGINT NOT NULL,
  role         TEXT NOT NULL,
  text         TEXT NOT NULL DEFAULT '',
  tool_calls   TEXT,
  tool_results TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  version      BIGINT NOT NULL DEFAULT 1,
  server_seq   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_user_seq ON chat_messages (user_id, server_seq);

CREATE TABLE IF NOT EXISTS notification_reads (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  fire_at    TEXT NOT NULL,
  read_at    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version    BIGINT NOT NULL DEFAULT 1,
  server_seq BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_reads_user_seq ON notification_reads (user_id, server_seq);

CREATE TABLE IF NOT EXISTS calendar_feeds (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'ics',   -- 'ics' subscription or 'caldav' collection (PLAN-caldav.md)
  account_id TEXT,                          -- owning calendar_accounts row of a caldav feed
  read_only  BIGINT NOT NULL DEFAULT 0,
  url        TEXT NOT NULL DEFAULT '',
  ics_text   TEXT,                          -- raw uploaded .ics (parsed in place); NULL for URL feeds
  color      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version    BIGINT NOT NULL DEFAULT 1,
  server_seq BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_feeds_user_seq ON calendar_feeds (user_id, server_seq);

-- Server-owned clones of expanded ICS occurrences (PLAN §6.7). Written only by the
-- server's fetcher; clients pull them read-only. The event id is deterministic
-- (UUIDv5 of feed|uid|occurrence-start) so re-fetches upsert in place.
CREATE TABLE IF NOT EXISTS calendar_events (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  feed_id     TEXT NOT NULL,
  ics_uid     TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  starts_at   TEXT NOT NULL,
  ends_at     TEXT,
  all_day     BIGINT NOT NULL DEFAULT 0,
  location    TEXT,
  description TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  version     BIGINT NOT NULL DEFAULT 1,
  server_seq  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_events_user_seq ON calendar_events (user_id, server_seq);
CREATE INDEX IF NOT EXISTS idx_calendar_events_feed ON calendar_events (feed_id);

-- CalDAV (PLAN-caldav.md): a login, and the verbatim ICS of each event resource. The server
-- never contacts a calendar provider — only native clients do — so it needs nothing from these
-- rows but their sync metadata. The body is kept whole in row_json; on encrypted accounts every
-- content field inside it (server URL, username, credential, href, ICS) is an enc$v1$ envelope.
CREATE TABLE IF NOT EXISTS calendar_accounts (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  row_json   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version    BIGINT NOT NULL DEFAULT 0,
  server_seq BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_accounts_user_seq ON calendar_accounts (user_id, server_seq);

CREATE TABLE IF NOT EXISTS calendar_objects (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  row_json   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version    BIGINT NOT NULL DEFAULT 0,
  server_seq BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_objects_user_seq ON calendar_objects (user_id, server_seq);

CREATE TABLE IF NOT EXISTS user_secrets (
  user_id    TEXT NOT NULL,
  key        TEXT NOT NULL,
  value_enc  BYTEA NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- End-to-end encryption key material (PLAN §E2EE). Every column here is opaque to the
-- server: the master key is stored only wrapped (encrypted) by a key the server never sees,
-- so the operator holds ciphertext for both the content and the key that decrypts it. A row
-- exists only for accounts that have enabled encryption; its absence means "plaintext account".
CREATE TABLE IF NOT EXISTS user_keys (
  user_id            TEXT PRIMARY KEY,
  wrapped_master_key TEXT NOT NULL,   -- enc$v1$… : master key sealed with the password-derived KEK
  kdf_salt           TEXT NOT NULL,   -- base64 salt fed to Argon2id to reproduce the KEK
  kdf_time           BIGINT NOT NULL, -- Argon2id iterations
  kdf_memory_k       BIGINT NOT NULL, -- Argon2id memory (KiB)
  kdf_threads        BIGINT NOT NULL, -- Argon2id parallelism
  recovery_wrapped   TEXT,            -- enc$v1$… : same master key sealed with the recovery code
  public_key         TEXT,            -- base64 X25519 public key (reserved for sealed-box calendar)
  updated_at         TEXT NOT NULL
);

-- Devices (PLAN-agents.md §1.4). One row per install; the client mints the id. name is an
-- enc$v1$ envelope on encrypted accounts. can_host marks desktops that run local agents;
-- "online" is not stored — it is whether the device holds an open relay inbox right now.
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  name         TEXT NOT NULL DEFAULT '',
  platform     TEXT NOT NULL DEFAULT '',
  can_host     INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices (user_id);

-- Installed agents (PLAN-agents.md): the synced "agent" entity. Content fields travel inside
-- row_json (encrypted per field on E2EE accounts); runtime and host_device_id are mirrored as
-- plaintext columns so routing never needs to decrypt.
CREATE TABLE IF NOT EXISTS agents (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  runtime        TEXT NOT NULL DEFAULT '',
  host_device_id TEXT,
  row_json       TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  version        BIGINT NOT NULL DEFAULT 0,
  server_seq     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_user_seq ON agents (user_id, server_seq);

-- Relay requests (PLAN-agents.md §5.1): a short-lived record of one device asking another to
-- run something. payload is sealed by the client; the server routes on device ids only. Rows
-- expire after a few minutes and exist so a lost frame yields a definite error, not silence.
CREATE TABLE IF NOT EXISTS relay_requests (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  from_device_id TEXT NOT NULL,
  to_device_id   TEXT NOT NULL,
  method         TEXT NOT NULL,
  status         TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relay_requests_user ON relay_requests (user_id, created_at);
`

// OpenDB opens the store, choosing the driver from the DSN: a postgres:// URL uses
// pgx; anything else is treated as a SQLite path (dev + tests). It returns the
// dialect so queries can be rebound to the right placeholder style.
func OpenDB(dsn string) (*sql.DB, string, error) {
	dialect, driver := "sqlite", "sqlite"
	if strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://") {
		dialect, driver = "postgres", "pgx"
	}
	db, err := sql.Open(driver, dsn)
	if err != nil {
		return nil, "", fmt.Errorf("open %s: %w", dialect, err)
	}
	if dialect == "sqlite" {
		db.SetMaxOpenConns(1) // serialize; keeps :memory: alive
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, "", fmt.Errorf("apply schema: %w", err)
	}
	if err := migrate(db, dialect); err != nil {
		db.Close()
		return nil, "", fmt.Errorf("migrate: %w", err)
	}
	return db, dialect, nil
}

// migrate applies column additions that a plain `CREATE TABLE IF NOT EXISTS`
// can't retrofit onto an already-created table (e.g. a dev SQLite file from
// before refresh-token support). Each step is idempotent: a duplicate-column
// error means the migration already ran.
func migrate(db *sql.DB, dialect string) error {
	alters := []string{
		`ALTER TABLE sessions ADD COLUMN expires_at TEXT`,
		// Trash marker on notes (PLAN §4.3), retrofitted onto pre-Trash dev DBs.
		`ALTER TABLE notes ADD COLUMN deleting_at TEXT`,
		// Archetype columns (PLAN §6.3), retrofitted onto pre-Objects dev DBs.
		`ALTER TABLE notes ADD COLUMN object_type_id TEXT`,
		`ALTER TABLE notes ADD COLUMN props_json TEXT NOT NULL DEFAULT '{}'`,
		`ALTER TABLE tasks ADD COLUMN object_type_id TEXT`,
		`ALTER TABLE tasks ADD COLUMN props_json TEXT NOT NULL DEFAULT '{}'`,
		// Per-chat model selection (PLAN §6.8): the model moved out of llm_configs onto the chat.
		`ALTER TABLE chats ADD COLUMN model TEXT`,
		// Uploaded .ics feeds (PLAN §6.7), retrofitted onto pre-upload dev DBs.
		`ALTER TABLE calendar_feeds ADD COLUMN ics_text TEXT`,
		// Account profile names (self-serve settings), retrofitted onto pre-name dev DBs.
		`ALTER TABLE users ADD COLUMN first_name TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE users ADD COLUMN last_name TEXT NOT NULL DEFAULT ''`,
		// Email verification marker (cloud gates subscribing on it), retrofitted onto older DBs.
		`ALTER TABLE users ADD COLUMN email_verified_at TEXT`,
		// Forgot-password token (rotated per request), retrofitted onto older DBs.
		`ALTER TABLE users ADD COLUMN password_reset_token TEXT`,
		`ALTER TABLE users ADD COLUMN password_reset_expires_at TEXT`,
		// CalDAV calendars (PLAN-caldav.md), retrofitted onto pre-CalDAV DBs.
		`ALTER TABLE calendar_feeds ADD COLUMN kind TEXT NOT NULL DEFAULT 'ics'`,
		`ALTER TABLE calendar_feeds ADD COLUMN account_id TEXT`,
		`ALTER TABLE calendar_feeds ADD COLUMN read_only BIGINT NOT NULL DEFAULT 0`,
		// Canvas edge line style (PLAN-canvases.md), retrofitted onto pre-style dev DBs.
		`ALTER TABLE canvas_edges ADD COLUMN style TEXT NOT NULL DEFAULT 'curved'`,
		// Task start + reminder lists (PLAN §6.4), retrofitted onto pre-reminders DBs.
		`ALTER TABLE tasks ADD COLUMN start_at TEXT`,
		`ALTER TABLE tasks ADD COLUMN reminders_json TEXT NOT NULL DEFAULT '[]'`,
		// Area and project pages, and content filed directly in an area (PLAN-areas.md),
		// retrofitted onto pre-overview DBs. For an 'area' membership project_id is the area's id.
		`ALTER TABLE areas ADD COLUMN icon TEXT`,
		`ALTER TABLE areas ADD COLUMN cover_document_id TEXT`,
		`ALTER TABLE areas ADD COLUMN description_md TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE projects ADD COLUMN icon TEXT`,
		`ALTER TABLE projects ADD COLUMN cover_document_id TEXT`,
		`ALTER TABLE projects ADD COLUMN description_md TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE project_members ADD COLUMN container_type TEXT NOT NULL DEFAULT 'project'`,
	}
	for _, alter := range alters {
		if dialect == "postgres" {
			alter = strings.Replace(alter, "ADD COLUMN", "ADD COLUMN IF NOT EXISTS", 1)
		}
		if _, err := db.Exec(alter); err != nil && !strings.Contains(err.Error(), "duplicate column") {
			return err
		}
	}
	// Steps that need the columns above; each is idempotent, so they rerun safely on every boot.
	steps := []string{
		// A task's single pre-reminders remind_at becomes the first entry of its list and is
		// cleared, so a rerun finds nothing to move and a later "no reminders" edit is never
		// undone from the stale column. Clients move their copies the same way (core/store
		// 0024_task_start_reminders.sql), so both sides agree without a re-sync.
		`UPDATE tasks SET reminders_json = '[{"at":"' || remind_at || '"}]', remind_at = NULL WHERE remind_at IS NOT NULL`,
		// One occurrence per (seed, start) for a start-anchored repeat, whose occurrences carry
		// no deadline; idx_tasks_occurrence already covers the deadline-anchored ones.
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_occurrence_start ON tasks (repeat_seed_id, start_at) WHERE due_at IS NULL`,
	}
	for _, step := range steps {
		if _, err := db.Exec(step); err != nil {
			return err
		}
	}
	return nil
}

// rebind converts the '?' placeholders used throughout the queries to Postgres'
// positional '$N' form. Our SQL never contains a literal '?', so a simple scan is
// safe.
func rebind(dialect, query string) string {
	if dialect != "postgres" {
		return query
	}
	var b strings.Builder
	n := 0
	for i := 0; i < len(query); i++ {
		if query[i] == '?' {
			n++
			b.WriteByte('$')
			b.WriteString(strconv.Itoa(n))
			continue
		}
		b.WriteByte(query[i])
	}
	return b.String()
}

// nextSeq bumps and returns the per-user monotonic sequence, inside tx.
func (s *Server) nextSeq(tx *sql.Tx, userID string) (int64, error) {
	if _, err := tx.Exec(s.rebind(
		`INSERT INTO user_seq (user_id, seq) VALUES (?, 0) ON CONFLICT (user_id) DO NOTHING;`), userID); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(s.rebind(`UPDATE user_seq SET seq = seq + 1 WHERE user_id = ?;`), userID); err != nil {
		return 0, err
	}
	var seq int64
	if err := tx.QueryRow(s.rebind(`SELECT seq FROM user_seq WHERE user_id = ?;`), userID).Scan(&seq); err != nil {
		return 0, err
	}
	return seq, nil
}
