package store

import "fmt"

// reencryptTables are every syncable table that carries encryptable content (PLAN §E2EE). Marking
// their rows dirty re-pushes each one, so the next sync (with encryption now enabled) overwrites
// the server's plaintext copy with ciphertext. Tables with no protected fields are omitted — there
// is nothing to re-encrypt there, so re-pushing them would be pure churn.
var reencryptTables = []string{
	"notes",
	"tasks",
	"areas",
	"projects",
	"object_types",
	"documents",
	"chats",
	"chat_messages",
	"calendar_feeds",
	"calendar_events",
}

// MarkAllForReencryption flags every content row dirty so a following sync re-pushes it encrypted.
// It is the local half of enabling encryption on an existing (plaintext) account: after the
// credential is swapped and the wrapped key uploaded, this queues every row to be rewritten as
// ciphertext on the server (PLAN §E2EE). It only touches live rows — tombstones carry no content
// to protect. Returns the number of rows flagged.
func (s *Store) MarkAllForReencryption() (int, error) {
	var total int
	for _, table := range reencryptTables {
		res, err := s.db.Exec(`UPDATE ` + table + ` SET dirty = 1 WHERE deleted_at IS NULL;`)
		if err != nil {
			return total, fmt.Errorf("mark %s dirty: %w", table, err)
		}
		n, _ := res.RowsAffected()
		total += int(n)
	}
	return total, nil
}
