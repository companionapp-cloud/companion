package main

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
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

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
  due_at         TEXT,
  remind_at      TEXT,
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

CREATE TABLE IF NOT EXISTS chats (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  config_id  TEXT,
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

CREATE TABLE IF NOT EXISTS user_secrets (
  user_id    TEXT NOT NULL,
  key        TEXT NOT NULL,
  value_enc  BYTEA NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
`

// openDB opens the store, choosing the driver from the DSN: a postgres:// URL uses
// pgx; anything else is treated as a SQLite path (dev + tests). It returns the
// dialect so queries can be rebound to the right placeholder style.
func openDB(dsn string) (*sql.DB, string, error) {
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
	}
	for _, alter := range alters {
		if dialect == "postgres" {
			alter = strings.Replace(alter, "ADD COLUMN", "ADD COLUMN IF NOT EXISTS", 1)
		}
		if _, err := db.Exec(alter); err != nil && !strings.Contains(err.Error(), "duplicate column") {
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
