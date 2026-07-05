package store

import (
	"fmt"
	"time"

	"companion/core/domain"

	"github.com/google/uuid"
)

// ---- sync_state (per-device cursor) --------------------------------------

// EnsureSyncState creates the singleton sync_state row for this device if absent.
func (s *Store) EnsureSyncState(deviceID string) error {
	_, err := s.db.Exec(
		`INSERT INTO sync_state (id, device_id, server_cursor) VALUES (1, ?, 0)
		 ON CONFLICT(id) DO NOTHING;`, deviceID)
	if err != nil {
		return fmt.Errorf("ensure sync_state: %w", err)
	}
	return nil
}

// Cursor returns the last server_seq pulled (0 if never synced).
func (s *Store) Cursor() (int64, error) {
	rows, err := s.db.Query(`SELECT server_cursor FROM sync_state WHERE id = 1;`)
	if err != nil {
		return 0, fmt.Errorf("read cursor: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		return 0, rows.Err()
	}
	var cursor int64
	if err := rows.Scan(&cursor); err != nil {
		return 0, err
	}
	return cursor, nil
}

// SetCursor advances the pulled cursor and records the sync time.
func (s *Store) SetCursor(cursor int64, at time.Time) error {
	_, err := s.db.Exec(
		`UPDATE sync_state SET server_cursor = ?, last_synced_at = ? WHERE id = 1;`,
		cursor, at.UTC().Format(timeFormat))
	if err != nil {
		return fmt.Errorf("set cursor: %w", err)
	}
	return nil
}

// ---- notes sync ----------------------------------------------------------

// Dirty returns every locally-changed note (including tombstones), oldest first, for
// pushing to the server.
func (r *NotesRepo) Dirty() ([]*domain.Note, error) {
	rows, err := r.db.Query(
		`SELECT ` + noteColumns + ` FROM notes WHERE dirty = 1 ORDER BY updated_at ASC, id ASC;`)
	if err != nil {
		return nil, fmt.Errorf("query dirty notes: %w", err)
	}
	defer rows.Close()
	out := []*domain.Note{}
	for rows.Next() {
		n, err := scanNote(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// GetAny returns a note by id regardless of its deleted state, or ErrNotFound. Used
// by sync to inspect the current local row (including tombstones) during conflicts.
func (r *NotesRepo) GetAny(id string) (*domain.Note, error) {
	rows, err := r.db.Query(`SELECT `+noteColumns+` FROM notes WHERE id = ?;`, id)
	if err != nil {
		return nil, fmt.Errorf("query note: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanNote(rows)
}

// Apply overwrites the local note with a server-canonical row and clears dirty. Used
// when the server copy wins (or the local row was clean).
func (r *NotesRepo) Apply(n *domain.Note) error {
	var deletedAt any
	if n.DeletedAt != nil {
		deletedAt = n.DeletedAt.UTC().Format(timeFormat)
	}
	_, err := r.db.Exec(
		`INSERT INTO notes (id, title, content_md, date, created_at, updated_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   title = excluded.title, content_md = excluded.content_md, date = excluded.date,
		   created_at = excluded.created_at, updated_at = excluded.updated_at,
		   deleted_at = excluded.deleted_at, version = excluded.version, dirty = 0;`,
		n.ID, n.Title, n.ContentMD, n.Date,
		n.CreatedAt.UTC().Format(timeFormat), n.UpdatedAt.UTC().Format(timeFormat), deletedAt, n.Version,
	)
	if err != nil {
		return fmt.Errorf("apply note: %w", err)
	}
	// Re-derive links from the applied content so a synced device builds the same
	// index as the device that authored the change (PLAN §5.1). A tombstone drops the
	// source's outgoing edges.
	if n.DeletedAt != nil {
		return r.links.DeleteSource(domain.NodeNote, n.ID)
	}
	return r.links.SyncSource(domain.NodeNote, n.ID, n.ContentMD)
}

// MarkPushed clears the dirty flag and records the server version after a successful
// push.
func (r *NotesRepo) MarkPushed(id string, version int64) error {
	_, err := r.db.Exec(`UPDATE notes SET dirty = 0, version = ? WHERE id = ?;`, version, id)
	if err != nil {
		return fmt.Errorf("mark pushed: %w", err)
	}
	return nil
}

// CreateConflictedCopy forks a losing local note into a brand-new note (fresh
// UUIDv7, titled with the given suffix) that will push as a new row next cycle, so
// nothing the user typed is silently lost (§5.3).
func (r *NotesRepo) CreateConflictedCopy(from *domain.Note, suffix string) (*domain.Note, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return nil, fmt.Errorf("generate uuid: %w", err)
	}
	now := r.clock.Now().UTC()
	title := from.Title
	if title == "" {
		title = "Untitled"
	}
	copy := &domain.Note{
		ID:        id.String(),
		Title:     title + " " + suffix,
		ContentMD: from.ContentMD,
		Date:      from.Date,
		CreatedAt: now,
		UpdatedAt: now,
		Version:   0,
		Dirty:     true,
	}
	_, err = r.db.Exec(
		`INSERT INTO notes (id, title, content_md, date, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, 0, 1);`,
		copy.ID, copy.Title, copy.ContentMD, copy.Date,
		copy.CreatedAt.Format(timeFormat), copy.UpdatedAt.Format(timeFormat),
	)
	if err != nil {
		return nil, fmt.Errorf("insert conflicted copy: %w", err)
	}
	if err := r.links.SyncSource(domain.NodeNote, copy.ID, copy.ContentMD); err != nil {
		return nil, err
	}
	return copy, nil
}
