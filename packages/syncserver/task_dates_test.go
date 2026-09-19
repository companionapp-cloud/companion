package syncserver

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// TestMigrateMovesRemindAtIntoReminders boots the server on a database from before task
// starts and reminder lists: each single remind_at must become the first entry of
// reminders_json and be cleared, and booting again must change nothing (the step reruns on
// every start).
func TestMigrateMovesRemindAtIntoReminders(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	old, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(`CREATE TABLE tasks (
		id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
		notes_md TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
		due_at TEXT, remind_at TEXT, completed_at TEXT, repeat_rule TEXT, repeat_seed_id TEXT,
		created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleting_at TEXT, deleted_at TEXT,
		version BIGINT NOT NULL DEFAULT 1, server_seq BIGINT NOT NULL);
		INSERT INTO tasks (id, user_id, remind_at, created_at, updated_at, server_seq)
		VALUES ('with', 'u1', '2026-10-09T13:00:00Z', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', 7),
		       ('without', 'u1', NULL, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', 8);`); err != nil {
		t.Fatal(err)
	}
	old.Close()

	check := func(boot int) {
		db, _, err := OpenDB(path)
		if err != nil {
			t.Fatalf("boot %d: %v", boot, err)
		}
		defer db.Close()
		want := map[string]string{"with": `[{"at":"2026-10-09T13:00:00Z"}]`, "without": "[]"}
		for id, reminders := range want {
			var got string
			var remindAt, startAt sql.NullString
			var seq int64
			if err := db.QueryRow(`SELECT reminders_json, remind_at, start_at, server_seq FROM tasks WHERE id = ?`, id).
				Scan(&got, &remindAt, &startAt, &seq); err != nil {
				t.Fatalf("boot %d: read %s: %v", boot, id, err)
			}
			if got != reminders || remindAt.Valid || startAt.Valid {
				t.Errorf("boot %d: %s reminders %s remind_at %v start_at %v, want %s and both NULL", boot, id, got, remindAt, startAt, reminders)
			}
			// The move is a schema migration, not an edit: rows keep their sequence numbers.
			if (id == "with" && seq != 7) || (id == "without" && seq != 8) {
				t.Errorf("boot %d: %s server_seq changed to %d", boot, id, seq)
			}
		}
	}
	check(1)
	check(2)
}
