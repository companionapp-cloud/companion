package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"companion/core/domain"
	"companion/core/sync/protocol"

	"github.com/google/uuid"
)

// AreasRepo is the CRUD + sync repository for areas (PLAN §6.6). Areas are a flat,
// ordered list of sidebar headings; they group projects but are not graph nodes.
type AreasRepo struct {
	db    Driver
	clock domain.Clock
}

const areaColumns = `id, name, color, sort_order, created_at, updated_at, deleted_at, version, dirty`

// CreateAreaInput carries the client-supplied fields for a new area.
type CreateAreaInput struct {
	Name      string  `json:"name"`
	Color     *string `json:"color,omitempty"`
	SortOrder int     `json:"sortOrder"`
}

// UpdateAreaInput carries partial updates; nil fields are left unchanged.
type UpdateAreaInput struct {
	Name      *string `json:"name,omitempty"`
	Color     *string `json:"color,omitempty"`
	SortOrder *int    `json:"sortOrder,omitempty"`
}

// Create inserts a new area (UUIDv7 id, version 0, dirty).
func (r *AreasRepo) Create(in CreateAreaInput) (*domain.Area, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return nil, fmt.Errorf("generate uuid: %w", err)
	}
	now := r.clock.Now().UTC()
	// A new area lands at the end of the list. Callers that supply an explicit order (e.g.
	// seeds) keep it; the UI passes none, so we assign the next slot.
	order := in.SortOrder
	if order == 0 {
		if order, err = r.nextOrder(); err != nil {
			return nil, err
		}
	}
	a := &domain.Area{
		ID: id.String(), Name: in.Name, Color: in.Color, SortOrder: order,
		CreatedAt: now, UpdatedAt: now, Version: 0, Dirty: true,
	}
	if err := a.Validate(); err != nil {
		return nil, err
	}
	if _, err := r.db.Exec(
		`INSERT INTO areas (id, name, color, sort_order, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
		a.ID, a.Name, a.Color, a.SortOrder,
		a.CreatedAt.Format(timeFormat), a.UpdatedAt.Format(timeFormat), a.Version, boolToInt(a.Dirty),
	); err != nil {
		return nil, fmt.Errorf("insert area: %w", err)
	}
	return a, nil
}

// nextOrder returns the sort_order for a new area appended after all existing ones.
func (r *AreasRepo) nextOrder() (int, error) {
	rows, err := r.db.Query(`SELECT COALESCE(MAX(sort_order), -1) + 1 FROM areas WHERE deleted_at IS NULL;`)
	if err != nil {
		return 0, fmt.Errorf("next area order: %w", err)
	}
	defer rows.Close()
	next := 0
	if rows.Next() {
		if err := rows.Scan(&next); err != nil {
			return 0, err
		}
	}
	return next, rows.Err()
}

// Reorder assigns sort_order = position for each id in `ids` (its new top-to-bottom
// order), bumping updated_at and marking each dirty so the order syncs (PLAN §6.6). Ids
// not listed are left untouched. Used by the sidebar / home drag-and-drop.
func (r *AreasRepo) Reorder(ids []string) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	for i, id := range ids {
		if _, err := r.db.Exec(
			`UPDATE areas SET sort_order = ?, updated_at = ?, dirty = 1 WHERE id = ? AND deleted_at IS NULL;`,
			i, now, id,
		); err != nil {
			return fmt.Errorf("reorder areas: %w", err)
		}
	}
	return nil
}

// Get returns a single non-deleted area by id, or ErrNotFound.
func (r *AreasRepo) Get(id string) (*domain.Area, error) {
	rows, err := r.db.Query(`SELECT `+areaColumns+` FROM areas WHERE id = ? AND deleted_at IS NULL;`, id)
	if err != nil {
		return nil, fmt.Errorf("query area: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanArea(rows)
}

// List returns all non-deleted areas, by sort_order then name.
func (r *AreasRepo) List() ([]*domain.Area, error) {
	rows, err := r.db.Query(
		`SELECT ` + areaColumns + ` FROM areas WHERE deleted_at IS NULL ORDER BY sort_order, name, id;`)
	if err != nil {
		return nil, fmt.Errorf("query areas: %w", err)
	}
	defer rows.Close()
	out := []*domain.Area{}
	for rows.Next() {
		a, err := scanArea(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// Update applies partial changes, bumps updated_at, marks dirty.
func (r *AreasRepo) Update(id string, in UpdateAreaInput) (*domain.Area, error) {
	a, err := r.Get(id)
	if err != nil {
		return nil, err
	}
	if in.Name != nil {
		a.Name = *in.Name
	}
	if in.Color != nil {
		a.Color = in.Color
	}
	if in.SortOrder != nil {
		a.SortOrder = *in.SortOrder
	}
	a.UpdatedAt = r.clock.Now().UTC()
	a.Dirty = true
	if err := a.Validate(); err != nil {
		return nil, err
	}
	res, err := r.db.Exec(
		`UPDATE areas SET name = ?, color = ?, sort_order = ?, updated_at = ?, dirty = 1
		 WHERE id = ? AND deleted_at IS NULL;`,
		a.Name, a.Color, a.SortOrder, a.UpdatedAt.Format(timeFormat), id,
	)
	if err != nil {
		return nil, fmt.Errorf("update area: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return nil, ErrNotFound
	}
	return a, nil
}

// Delete soft-deletes an area. Its projects keep their (now dangling) area_id and
// render under "Unsorted" — deletion does not cascade (PLAN §6.6).
func (r *AreasRepo) Delete(id string) error {
	now := r.clock.Now().UTC()
	res, err := r.db.Exec(
		`UPDATE areas SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ? AND deleted_at IS NULL;`,
		now.Format(timeFormat), now.Format(timeFormat), id,
	)
	if err != nil {
		return fmt.Errorf("delete area: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	return nil
}

// --- SyncableRepo[*domain.Area] -------------------------------------------

func (r *AreasRepo) EntityType() string { return protocol.EntityArea }

func (r *AreasRepo) Dirty() ([]*domain.Area, error) {
	rows, err := r.db.Query(`SELECT ` + areaColumns + ` FROM areas WHERE dirty = 1 ORDER BY updated_at ASC, id ASC;`)
	if err != nil {
		return nil, fmt.Errorf("query dirty areas: %w", err)
	}
	defer rows.Close()
	out := []*domain.Area{}
	for rows.Next() {
		a, err := scanArea(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (r *AreasRepo) GetAny(id string) (*domain.Area, error) {
	rows, err := r.db.Query(`SELECT `+areaColumns+` FROM areas WHERE id = ?;`, id)
	if err != nil {
		return nil, fmt.Errorf("query area: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanArea(rows)
}

func (r *AreasRepo) Apply(a *domain.Area) error {
	var deletedAt any
	if a.DeletedAt != nil {
		deletedAt = a.DeletedAt.UTC().Format(timeFormat)
	}
	_, err := r.db.Exec(
		`INSERT INTO areas (id, name, color, sort_order, created_at, updated_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   name = excluded.name, color = excluded.color, sort_order = excluded.sort_order,
		   created_at = excluded.created_at, updated_at = excluded.updated_at,
		   deleted_at = excluded.deleted_at, version = excluded.version, dirty = 0;`,
		a.ID, a.Name, a.Color, a.SortOrder,
		a.CreatedAt.UTC().Format(timeFormat), a.UpdatedAt.UTC().Format(timeFormat), deletedAt, a.Version,
	)
	if err != nil {
		return fmt.Errorf("apply area: %w", err)
	}
	return nil
}

func (r *AreasRepo) MarkPushed(id string, version int64) error {
	if _, err := r.db.Exec(`UPDATE areas SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark pushed: %w", err)
	}
	return nil
}

func (r *AreasRepo) MeaningfulDiff(a, b *domain.Area) bool {
	if a.Name != b.Name || derefStr(a.Color) != derefStr(b.Color) || a.SortOrder != b.SortOrder {
		return true
	}
	return (a.DeletedAt == nil) != (b.DeletedAt == nil)
}

func (r *AreasRepo) Decode(raw json.RawMessage) (*domain.Area, error) {
	var a domain.Area
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, fmt.Errorf("decode area: %w", err)
	}
	return &a, nil
}

// ConflictedCopy forks a losing local area into a fresh row so a local rename is never
// silently lost (§7.3).
func (r *AreasRepo) ConflictedCopy(local *domain.Area, suffix string) error {
	id, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("generate uuid: %w", err)
	}
	now := r.clock.Now().UTC()
	name := local.Name
	if name == "" {
		name = "Untitled"
	}
	_, err = r.db.Exec(
		`INSERT INTO areas (id, name, color, sort_order, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, 0, 1);`,
		id.String(), name+" "+suffix, local.Color, local.SortOrder,
		now.Format(timeFormat), now.Format(timeFormat),
	)
	if err != nil {
		return fmt.Errorf("insert conflicted area: %w", err)
	}
	return nil
}

func scanArea(rows Rows) (*domain.Area, error) {
	var (
		a                    domain.Area
		color, deletedAt     sql.NullString
		createdAt, updatedAt string
		dirty                int
	)
	if err := rows.Scan(&a.ID, &a.Name, &color, &a.SortOrder, &createdAt, &updatedAt, &deletedAt, &a.Version, &dirty); err != nil {
		return nil, fmt.Errorf("scan area: %w", err)
	}
	if color.Valid {
		a.Color = &color.String
	}
	var err error
	if a.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if a.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	if deletedAt.Valid {
		t, err := time.Parse(timeFormat, deletedAt.String)
		if err != nil {
			return nil, fmt.Errorf("parse deleted_at: %w", err)
		}
		a.DeletedAt = &t
	}
	a.Dirty = dirty != 0
	return &a, nil
}
