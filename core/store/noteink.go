package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"companion/core/domain"
	"companion/core/sync/protocol"
)

// NoteInkRepo owns the ink groups drawn over notes (PLAN-drawing.md). Each group is a synced
// row keyed by its note. The editor picks group ids and always writes a group whole, so a
// concurrent edit of one group resolves last-writer-wins while different groups merge.
type NoteInkRepo struct {
	db    Driver
	clock domain.Clock
}

const noteInkColumns = `id, note_id, data_json, created_at, updated_at, deleted_at, version, dirty`

// NoteInkInput is one group as the editor writes it: its id (new or known) and its whole
// payload. Upserting a tombstoned id brings the group back (undoing an erase).
type NoteInkInput struct {
	ID   string          `json:"id"`
	Data json.RawMessage `json:"data"`
}

// UpsertMany creates or overwrites a batch of groups on one note, returning the rows in
// input order. A known id must belong to the same note.
func (r *NoteInkRepo) UpsertMany(noteID string, inputs []NoteInkInput) ([]*domain.NoteInk, error) {
	now := r.clock.Now().UTC()
	out := make([]*domain.NoteInk, 0, len(inputs))
	for _, in := range inputs {
		g := &domain.NoteInk{
			ID: strings.TrimSpace(in.ID), NoteID: noteID, Data: json.RawMessage(normalizeProps(in.Data)),
			CreatedAt: now, UpdatedAt: now, Version: 0, Dirty: true,
		}
		if existing, err := r.GetAny(g.ID); err == nil {
			if existing.NoteID != noteID {
				return nil, errors.Join(domain.ErrInvalidNoteInk, errors.New("ink group belongs to another note"))
			}
			g.CreatedAt = existing.CreatedAt
			g.Version = existing.Version
		} else if !errors.Is(err, ErrNotFound) {
			return nil, err
		}
		if err := g.Validate(); err != nil {
			return nil, err
		}
		if _, err := r.db.Exec(
			`INSERT INTO note_ink (id, note_id, data_json, created_at, updated_at, deleted_at, version, dirty)
			 VALUES (?, ?, ?, ?, ?, NULL, ?, 1)
			 ON CONFLICT(id) DO UPDATE SET
			   data_json = excluded.data_json, updated_at = excluded.updated_at, deleted_at = NULL, dirty = 1;`,
			g.ID, g.NoteID, string(g.Data), g.CreatedAt.Format(timeFormat), g.UpdatedAt.Format(timeFormat), g.Version,
		); err != nil {
			return nil, fmt.Errorf("upsert note ink: %w", err)
		}
		out = append(out, g)
	}
	return out, nil
}

// ListForNote returns a note's live groups in creation order (the order they were drawn, so
// later groups paint over earlier ones).
func (r *NoteInkRepo) ListForNote(noteID string) ([]*domain.NoteInk, error) {
	return r.list(`SELECT `+noteInkColumns+` FROM note_ink WHERE note_id = ? AND deleted_at IS NULL ORDER BY created_at, id;`, noteID)
}

// DeleteMany tombstones groups (marking them dirty so the deletes sync) and returns how many
// live groups it removed.
func (r *NoteInkRepo) DeleteMany(ids []string) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	in, idArgs := placeholders(ids)
	now := r.clock.Now().UTC().Format(timeFormat)
	args := append([]any{now, now}, idArgs...)
	res, err := r.db.Exec(`UPDATE note_ink SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id IN (`+in+`) AND deleted_at IS NULL;`, args...)
	if err != nil {
		return 0, fmt.Errorf("delete note ink: %w", err)
	}
	affected, _ := res.RowsAffected()
	return affected, nil
}

// DeleteForNote tombstones every live group of a note, used when the note is purged. A note
// merely moved to the Trash keeps its ink, which comes back with it on restore.
func (r *NoteInkRepo) DeleteForNote(noteID string) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	if _, err := r.db.Exec(`UPDATE note_ink SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE note_id = ? AND deleted_at IS NULL;`, now, now, noteID); err != nil {
		return fmt.Errorf("delete note ink for note: %w", err)
	}
	return nil
}

func (r *NoteInkRepo) list(query string, args ...any) ([]*domain.NoteInk, error) {
	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query note ink: %w", err)
	}
	defer rows.Close()
	out := []*domain.NoteInk{}
	for rows.Next() {
		g, err := scanNoteInk(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// --- SyncableRepo[*domain.NoteInk] ---

func (r *NoteInkRepo) EntityType() string { return protocol.EntityNoteInk }

func (r *NoteInkRepo) Dirty() ([]*domain.NoteInk, error) {
	return r.list(`SELECT ` + noteInkColumns + ` FROM note_ink WHERE dirty = 1 ORDER BY updated_at ASC, id ASC;`)
}

func (r *NoteInkRepo) GetAny(id string) (*domain.NoteInk, error) {
	rows, err := r.db.Query(`SELECT `+noteInkColumns+` FROM note_ink WHERE id = ?;`, id)
	if err != nil {
		return nil, fmt.Errorf("query note ink: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanNoteInk(rows)
}

func (r *NoteInkRepo) Apply(g *domain.NoteInk) error {
	if _, err := r.db.Exec(
		`INSERT INTO note_ink (id, note_id, data_json, created_at, updated_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   note_id = excluded.note_id, data_json = excluded.data_json, created_at = excluded.created_at,
		   updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, version = excluded.version, dirty = 0;`,
		g.ID, g.NoteID, normalizeProps(g.Data), g.CreatedAt.UTC().Format(timeFormat), g.UpdatedAt.UTC().Format(timeFormat),
		fmtNullTime(g.DeletedAt), g.Version,
	); err != nil {
		return fmt.Errorf("apply note ink: %w", err)
	}
	return nil
}

func (r *NoteInkRepo) MarkPushed(id string, version int64) error {
	if _, err := r.db.Exec(`UPDATE note_ink SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark pushed: %w", err)
	}
	return nil
}

// MeaningfulDiff is always false: a forked copy of an ink group would draw the same strokes
// twice, so a concurrent edit of one group is last-writer-wins (PLAN-drawing.md), exactly as
// canvas nodes are.
func (r *NoteInkRepo) MeaningfulDiff(a, b *domain.NoteInk) bool { return false }

// ConflictedCopy is a no-op (never invoked, since MeaningfulDiff is always false).
func (r *NoteInkRepo) ConflictedCopy(local *domain.NoteInk, suffix string) error { return nil }

func (r *NoteInkRepo) Decode(raw json.RawMessage) (*domain.NoteInk, error) {
	var g domain.NoteInk
	if err := json.Unmarshal(raw, &g); err != nil {
		return nil, fmt.Errorf("decode note ink: %w", err)
	}
	return &g, nil
}

func scanNoteInk(rows Rows) (*domain.NoteInk, error) {
	var (
		g                          domain.NoteInk
		deletedAt                  sql.NullString
		data, createdAt, updatedAt string
		dirty                      int
	)
	if err := rows.Scan(&g.ID, &g.NoteID, &data, &createdAt, &updatedAt, &deletedAt, &g.Version, &dirty); err != nil {
		return nil, fmt.Errorf("scan note ink: %w", err)
	}
	g.Data = json.RawMessage(normalizeProps(json.RawMessage(data)))
	var err error
	if g.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if g.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	if g.DeletedAt, err = parseNullTime(deletedAt); err != nil {
		return nil, err
	}
	g.Dirty = dirty != 0
	return &g, nil
}
