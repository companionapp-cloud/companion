package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	"companion/core/domain"

	"github.com/google/uuid"
)

// ErrNotFound is returned when a row does not exist (or is soft-deleted).
var ErrNotFound = errors.New("not found")

// NotesRepo is the CRUD repository for notes.
type NotesRepo struct {
	db    Driver
	clock domain.Clock
	links *LinksRepo
}

// CreateNoteInput carries the client-supplied fields for a new note.
type CreateNoteInput struct {
	Title     string  `json:"title"`
	ContentMD string  `json:"contentMd"`
	Date      *string `json:"date,omitempty"`
}

// UpdateNoteInput carries partial updates; nil fields are left unchanged.
type UpdateNoteInput struct {
	Title     *string `json:"title,omitempty"`
	ContentMD *string `json:"contentMd,omitempty"`
	Date      *string `json:"date,omitempty"`
}

const timeFormat = time.RFC3339Nano

const noteColumns = `id, title, content_md, date, created_at, updated_at, deleted_at, version, dirty`

// Create inserts a new note with a client-generated UUIDv7 id (time-ordered),
// stamped created_at/updated_at, version 0 and dirty=1 (unsynced local edit).
func (r *NotesRepo) Create(in CreateNoteInput) (*domain.Note, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return nil, fmt.Errorf("generate uuid: %w", err)
	}
	now := r.clock.Now().UTC()
	n := &domain.Note{
		ID:        id.String(),
		Title:     in.Title,
		ContentMD: in.ContentMD,
		Date:      in.Date,
		CreatedAt: now,
		UpdatedAt: now,
		Version:   0,
		Dirty:     true,
	}
	if err := n.Validate(); err != nil {
		return nil, err
	}
	_, err = r.db.Exec(
		`INSERT INTO notes (id, title, content_md, date, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
		n.ID, n.Title, n.ContentMD, n.Date,
		n.CreatedAt.Format(timeFormat), n.UpdatedAt.Format(timeFormat), n.Version, boolToInt(n.Dirty),
	)
	if err != nil {
		return nil, fmt.Errorf("insert note: %w", err)
	}
	if err := r.links.SyncSource(domain.NodeNote, n.ID, n.ContentMD); err != nil {
		return nil, err
	}
	return n, nil
}

// Get returns a single non-deleted note by id, or ErrNotFound.
func (r *NotesRepo) Get(id string) (*domain.Note, error) {
	rows, err := r.db.Query(
		`SELECT `+noteColumns+` FROM notes WHERE id = ? AND deleted_at IS NULL;`, id)
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

// List returns all non-deleted notes, newest-updated first.
func (r *NotesRepo) List() ([]*domain.Note, error) {
	rows, err := r.db.Query(
		`SELECT ` + noteColumns + ` FROM notes WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC;`)
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
	n.UpdatedAt = r.clock.Now().UTC()
	n.Dirty = true
	if err := n.Validate(); err != nil {
		return nil, err
	}
	res, err := r.db.Exec(
		`UPDATE notes SET title = ?, content_md = ?, date = ?, updated_at = ?, dirty = 1
		 WHERE id = ? AND deleted_at IS NULL;`,
		n.Title, n.ContentMD, n.Date, n.UpdatedAt.Format(timeFormat), id,
	)
	if err != nil {
		return nil, fmt.Errorf("update note: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return nil, ErrNotFound
	}
	if err := r.links.SyncSource(domain.NodeNote, n.ID, n.ContentMD); err != nil {
		return nil, err
	}
	return n, nil
}

// Delete soft-deletes a note (sets deleted_at, marks dirty so the tombstone syncs).
// Deleting an already-deleted or missing note returns ErrNotFound.
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

func scanNote(rows Rows) (*domain.Note, error) {
	var (
		n                    domain.Note
		date, deletedAt      sql.NullString
		createdAt, updatedAt string
		dirty                int
	)
	if err := rows.Scan(&n.ID, &n.Title, &n.ContentMD, &date, &createdAt, &updatedAt, &deletedAt, &n.Version, &dirty); err != nil {
		return nil, fmt.Errorf("scan note: %w", err)
	}
	if date.Valid {
		n.Date = &date.String
	}
	var err error
	if n.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if n.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
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
