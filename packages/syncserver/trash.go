package syncserver

import (
	"context"
	"database/sql"
	"log"
	"time"
)

// The server owns Trash expiry (PLAN §4.3, §7.6). Clients only ever set deleting_at
// (delete) or clear it (restore); this collector is what actually turns an elapsed
// deleting_at into a tombstone, which then pulls down to every device as a normal delete.

// trashTables are the server tables carrying a deleting_at Trash marker. Projects and
// areas are never trashed, so they are absent here.
var trashTables = []string{"notes", "tasks", "documents"}

// trashSweepInterval is how often the collector wakes. Trash retention is measured in
// days, so hourly is ample precision (PLAN §7.6).
const trashSweepInterval = time.Hour

// StartTrashCollector sweeps expired Trash once immediately and then every hour until ctx
// is cancelled. Sweep errors are logged rather than fatal: a transient DB error simply
// retries on the next tick.
func (s *Server) StartTrashCollector(ctx context.Context) {
	sweep := func() {
		if n, err := s.PurgeExpired(); err != nil {
			log.Printf("trash collector: %v", err)
		} else if n > 0 {
			log.Printf("trash collector: purged %d expired row(s)", n)
		}
	}
	sweep()
	go func() {
		t := time.NewTicker(trashSweepInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				sweep()
			}
		}
	}()
}

// PurgeExpired promotes every trashed row whose deleting_at has elapsed to a tombstone:
// deleted_at set, a fresh version and server_seq so the change flows out through the
// normal pull path. It returns the number of rows purged, and notifies each affected
// user's live devices (§7.5) so their next sync pulls the tombstones. Each row is bumped
// in its own transaction so one failure can't wedge the whole sweep.
func (s *Server) PurgeExpired() (int, error) {
	now := s.clock.Now().UTC().Format(timeFormat)
	purged := 0
	maxSeqByUser := map[string]int64{}

	for _, table := range trashTables {
		type ref struct{ id, uid string }
		var due []ref
		rows, err := s.query(
			`SELECT id, user_id FROM `+table+
				` WHERE deleting_at IS NOT NULL AND deleted_at IS NULL AND deleting_at <= ?;`, now)
		if err != nil {
			return purged, err
		}
		for rows.Next() {
			var r ref
			if err := rows.Scan(&r.id, &r.uid); err != nil {
				rows.Close()
				return purged, err
			}
			due = append(due, r)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return purged, err
		}
		rows.Close()

		for _, r := range due {
			seq, err := s.purgeOne(table, r.uid, r.id)
			if err != nil {
				return purged, err
			}
			purged++
			if seq > maxSeqByUser[r.uid] {
				maxSeqByUser[r.uid] = seq
			}
			// A purged document releases its bytes: GC the blob from object storage when no
			// other live document row for that user still references the hash (PLAN §6.9,
			// §7.6). Best-effort — a failure only leaves an orphaned object, never data loss.
			if table == "documents" {
				if err := s.gcDocumentBlob(r.uid, r.id); err != nil {
					log.Printf("trash collector: blob gc for document %s: %v", r.id, err)
				}
			}
		}
	}

	for uid, seq := range maxSeqByUser {
		s.hub.publish(uid, seq)
	}
	return purged, nil
}

// gcDocumentBlob deletes a document's bytes from object storage when no other live document
// row for the same user still references the content hash (PLAN §6.9). The just-purged row
// is a tombstone (deleted_at set), so it is excluded by the deleted_at IS NULL filter — its
// own reference is already gone. Content addressing means two rows can share one blob (the
// same file attached twice), so the reference count, not the row, gates deletion.
func (s *Server) gcDocumentBlob(uid, id string) error {
	var sha string
	if err := s.queryRow(`SELECT sha256 FROM documents WHERE id = ? AND user_id = ?;`, id, uid).Scan(&sha); err != nil {
		return err
	}
	var one int
	err := s.queryRow(
		`SELECT 1 FROM documents WHERE user_id = ? AND sha256 = ? AND deleted_at IS NULL LIMIT 1;`, uid, sha).Scan(&one)
	if err == nil {
		return nil // still referenced by a live row; keep the bytes
	}
	if err != sql.ErrNoRows {
		return err
	}
	return s.blobs.Delete(context.Background(), blobKey(uid, sha))
}

// purgeOne tombstones a single expired row under a fresh version + server_seq, returning
// the seq it was assigned. deleted_at is stamped with the elapsed deleting_at instant.
func (s *Server) purgeOne(table, uid, id string) (int64, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	var version int64
	if err := tx.QueryRow(s.rebind(
		`SELECT version FROM `+table+` WHERE id = ? AND user_id = ?;`), id, uid).Scan(&version); err != nil {
		return 0, err
	}
	seq, err := s.nextSeq(tx, uid)
	if err != nil {
		return 0, err
	}
	now := s.clock.Now().UTC().Format(timeFormat)
	if _, err := tx.Exec(s.rebind(
		`UPDATE `+table+
			` SET deleted_at = deleting_at, updated_at = ?, version = ?, server_seq = ?
			  WHERE id = ? AND user_id = ?;`),
		now, version+1, seq, id, uid); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return seq, nil
}
