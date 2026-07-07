package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"companion/core/domain"

	"github.com/google/uuid"
)

// ErrNotFound is returned when a row does not exist (or is soft-deleted).
var ErrNotFound = errors.New("not found")

// NotesRepo is the CRUD repository for notes.
type NotesRepo struct {
	db          Driver
	clock       domain.Clock
	links       *LinksRepo
	objectTypes *ObjectTypesRepo

	// Held-note conflict interception (editor UX): when the UI has a note open for
	// editing it "holds" it, so a conflicting server version is stashed for the user to
	// resolve instead of being silently auto-forked by the sync engine (§7.3). Guarded by
	// mu because Hold/Release run on the UI path while the sync engine stashes/reads.
	mu           sync.Mutex
	heldID       string
	heldConflict *domain.Note
}

// CreateNoteInput carries the client-supplied fields for a new note. ObjectTypeID/Props
// archetype the note (PLAN §6.3); both are optional (a plain note has neither).
type CreateNoteInput struct {
	Title        string          `json:"title"`
	ContentMD    string          `json:"contentMd"`
	Date         *string         `json:"date,omitempty"`
	ObjectTypeID *string         `json:"objectTypeId,omitempty"`
	Props        json.RawMessage `json:"props,omitempty"`
}

// UpdateNoteInput carries partial updates; nil fields are left unchanged. ClearObjectType
// removes the archetype (JSON can't distinguish "absent" from "set to null" on a pointer).
type UpdateNoteInput struct {
	Title           *string          `json:"title,omitempty"`
	ContentMD       *string          `json:"contentMd,omitempty"`
	Date            *string          `json:"date,omitempty"`
	ObjectTypeID    *string          `json:"objectTypeId,omitempty"`
	ClearObjectType bool             `json:"clearObjectType,omitempty"`
	Props           *json.RawMessage `json:"props,omitempty"`
}

const timeFormat = time.RFC3339Nano

// TrashRetention is how long a trashed note lingers before it is due to be purged
// (PLAN §4.3). Trashing sets deleting_at = now + TrashRetention; the server's hourly
// collector tombstones rows once that instant passes (PLAN §7.6).
const TrashRetention = 30 * 24 * time.Hour

const noteColumns = `id, title, content_md, date, object_type_id, props_json, created_at, updated_at, deleting_at, deleted_at, version, dirty`

// Create inserts a new note with a client-generated UUIDv7 id (time-ordered),
// stamped created_at/updated_at, version 0 and dirty=1 (unsynced local edit).
func (r *NotesRepo) Create(in CreateNoteInput) (*domain.Note, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return nil, fmt.Errorf("generate uuid: %w", err)
	}
	now := r.clock.Now().UTC()
	n := &domain.Note{
		ID:           id.String(),
		Title:        in.Title,
		ContentMD:    in.ContentMD,
		Date:         in.Date,
		ObjectTypeID: in.ObjectTypeID,
		Props:        json.RawMessage(normalizeProps(in.Props)),
		CreatedAt:    now,
		UpdatedAt:    now,
		Version:      0,
		Dirty:        true,
	}
	if err := n.Validate(); err != nil {
		return nil, err
	}
	// Props must satisfy the archetype's schema — the same Go validation the server runs
	// on push (PLAN §6.3). A dangling type is tolerated (validation skipped).
	if err := r.objectTypes.ValidateEntityProps(n.ObjectTypeID, n.Props); err != nil {
		return nil, err
	}
	_, err = r.db.Exec(
		`INSERT INTO notes (id, title, content_md, date, object_type_id, props_json, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
		n.ID, n.Title, n.ContentMD, n.Date, n.ObjectTypeID, string(n.Props),
		n.CreatedAt.Format(timeFormat), n.UpdatedAt.Format(timeFormat), n.Version, boolToInt(n.Dirty),
	)
	if err != nil {
		return nil, fmt.Errorf("insert note: %w", err)
	}
	if err := r.links.SyncEntitySource(domain.NodeNote, n.ID, n.ContentMD, n.ObjectTypeID, string(n.Props)); err != nil {
		return nil, err
	}
	return n, nil
}

// Get returns a single live note by id, or ErrNotFound. Trashed notes (deleting_at set)
// are excluded — they surface only through ListTrash (PLAN §4.3).
func (r *NotesRepo) Get(id string) (*domain.Note, error) {
	rows, err := r.db.Query(
		`SELECT `+noteColumns+` FROM notes WHERE id = ? AND deleted_at IS NULL AND deleting_at IS NULL;`, id)
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

// List returns all live notes, newest-updated first. Trashed notes are excluded.
func (r *NotesRepo) List() ([]*domain.Note, error) {
	rows, err := r.db.Query(
		`SELECT ` + noteColumns + ` FROM notes WHERE deleted_at IS NULL AND deleting_at IS NULL ORDER BY updated_at DESC, id DESC;`)
	if err != nil {
		return nil, fmt.Errorf("query notes: %w", err)
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

// Update applies partial changes to a note, bumps updated_at and marks it dirty.
// Returns ErrNotFound if the note doesn't exist or is deleted.
func (r *NotesRepo) Update(id string, in UpdateNoteInput) (*domain.Note, error) {
	n, err := r.Get(id)
	if err != nil {
		return nil, err
	}
	if in.Title != nil {
		n.Title = *in.Title
	}
	if in.ContentMD != nil {
		n.ContentMD = *in.ContentMD
	}
	if in.Date != nil {
		n.Date = in.Date
	}
	if in.ClearObjectType {
		n.ObjectTypeID = nil
	} else if in.ObjectTypeID != nil {
		n.ObjectTypeID = in.ObjectTypeID
	}
	if in.Props != nil {
		n.Props = json.RawMessage(normalizeProps(*in.Props))
	}
	n.UpdatedAt = r.clock.Now().UTC()
	n.Dirty = true
	if err := n.Validate(); err != nil {
		return nil, err
	}
	if err := r.objectTypes.ValidateEntityProps(n.ObjectTypeID, n.Props); err != nil {
		return nil, err
	}
	res, err := r.db.Exec(
		`UPDATE notes SET title = ?, content_md = ?, date = ?, object_type_id = ?, props_json = ?,
		   updated_at = ?, dirty = 1
		 WHERE id = ? AND deleted_at IS NULL AND deleting_at IS NULL;`,
		n.Title, n.ContentMD, n.Date, n.ObjectTypeID, string(normalizeProps(n.Props)), n.UpdatedAt.Format(timeFormat), id,
	)
	if err != nil {
		return nil, fmt.Errorf("update note: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return nil, ErrNotFound
	}
	if err := r.links.SyncEntitySource(domain.NodeNote, n.ID, n.ContentMD, n.ObjectTypeID, string(normalizeProps(n.Props))); err != nil {
		return nil, err
	}
	return n, nil
}

// Delete tombstones a note (sets deleted_at, marks dirty so the tombstone syncs). This is
// the terminal "delete forever" primitive, reached from the Trash or by the server's
// collector once a trashed note's retention elapses. Deleting an already-tombstoned or
// missing note returns ErrNotFound. Everyday note deletion goes through Trash (PLAN §4.3).
func (r *NotesRepo) Delete(id string) error {
	now := r.clock.Now().UTC()
	res, err := r.db.Exec(
		`UPDATE notes SET deleted_at = ?, updated_at = ?, dirty = 1
		 WHERE id = ? AND deleted_at IS NULL;`,
		now.Format(timeFormat), now.Format(timeFormat), id,
	)
	if err != nil {
		return fmt.Errorf("delete note: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	// The source is gone; drop its outgoing edges. Incoming edges dangle by design.
	if err := r.links.DeleteSource(domain.NodeNote, id); err != nil {
		return err
	}
	return nil
}

// Trash moves a note to the Trash (PLAN §4.3): sets deleting_at = now + TrashRetention,
// bumps updated_at, and marks it dirty so the trashed state syncs. The note drops out of
// every query but ListTrash, and its outgoing links are removed so it leaves the graph.
// Trashing a missing, already-trashed, or tombstoned note returns ErrNotFound.
func (r *NotesRepo) Trash(id string) error {
	now := r.clock.Now().UTC()
	deletingAt := now.Add(TrashRetention)
	res, err := r.db.Exec(
		`UPDATE notes SET deleting_at = ?, updated_at = ?, dirty = 1
		 WHERE id = ? AND deleted_at IS NULL AND deleting_at IS NULL;`,
		deletingAt.Format(timeFormat), now.Format(timeFormat), id,
	)
	if err != nil {
		return fmt.Errorf("trash note: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	// Trashed rows leave the graph, mirroring a tombstone. Restore re-derives the edges.
	if err := r.links.DeleteSource(domain.NodeNote, id); err != nil {
		return err
	}
	return nil
}

// Restore brings a note back to life from either delete state (PLAN §4.3): it clears both
// deleting_at (Trash) and deleted_at (a tombstone — e.g. deleted on another device), bumps
// updated_at, marks it dirty so the resurrection syncs and wins, and re-derives its
// outgoing links. Restoring a note that is neither trashed nor tombstoned (or is missing)
// returns ErrNotFound.
func (r *NotesRepo) Restore(id string) error {
	n, err := r.GetAny(id)
	if err != nil {
		return err
	}
	if n.DeletedAt == nil && n.DeletingAt == nil {
		return ErrNotFound
	}
	now := r.clock.Now().UTC()
	res, err := r.db.Exec(
		`UPDATE notes SET deleting_at = NULL, deleted_at = NULL, updated_at = ?, dirty = 1
		 WHERE id = ? AND (deleted_at IS NOT NULL OR deleting_at IS NOT NULL);`,
		now.Format(timeFormat), id,
	)
	if err != nil {
		return fmt.Errorf("restore note: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	// Re-index the note as a live graph source now that it's back.
	if err := r.links.SyncEntitySource(domain.NodeNote, n.ID, n.ContentMD, n.ObjectTypeID, string(normalizeProps(n.Props))); err != nil {
		return err
	}
	return nil
}

// ListTrash returns every trashed note (deleting_at set, not yet tombstoned), soonest to
// be purged first. This is the one query that surfaces trashed rows (PLAN §4.3).
func (r *NotesRepo) ListTrash() ([]*domain.Note, error) {
	rows, err := r.db.Query(
		`SELECT ` + noteColumns + ` FROM notes WHERE deleted_at IS NULL AND deleting_at IS NOT NULL ORDER BY deleting_at ASC, id ASC;`)
	if err != nil {
		return nil, fmt.Errorf("query trashed notes: %w", err)
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

func scanNote(rows Rows) (*domain.Note, error) {
	var (
		n                                         domain.Note
		date, objectTypeID, deletingAt, deletedAt sql.NullString
		propsJSON                                 sql.NullString
		createdAt, updatedAt                      string
		dirty                                     int
	)
	if err := rows.Scan(&n.ID, &n.Title, &n.ContentMD, &date, &objectTypeID, &propsJSON, &createdAt, &updatedAt, &deletingAt, &deletedAt, &n.Version, &dirty); err != nil {
		return nil, fmt.Errorf("scan note: %w", err)
	}
	if date.Valid {
		n.Date = &date.String
	}
	if objectTypeID.Valid {
		n.ObjectTypeID = &objectTypeID.String
	}
	n.Props = json.RawMessage(normalizeProps([]byte(propsJSON.String)))
	var err error
	if n.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if n.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	if deletingAt.Valid {
		t, err := time.Parse(timeFormat, deletingAt.String)
		if err != nil {
			return nil, fmt.Errorf("parse deleting_at: %w", err)
		}
		n.DeletingAt = &t
	}
	if deletedAt.Valid {
		t, err := time.Parse(timeFormat, deletedAt.String)
		if err != nil {
			return nil, fmt.Errorf("parse deleted_at: %w", err)
		}
		n.DeletedAt = &t
	}
	n.Dirty = dirty != 0
	return &n, nil
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
