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

// ProjectsRepo is the CRUD + sync repository for projects (PLAN §6.6). A project
// belongs to exactly one area (area_id column) and appears as a graph node so member
// edges resolve.
type ProjectsRepo struct {
	db    Driver
	clock domain.Clock
}

const projectColumns = `id, area_id, name, color, sort_order, archived_at, created_at, updated_at, deleted_at, version, dirty`

// CreateProjectInput carries the client-supplied fields for a new project.
type CreateProjectInput struct {
	AreaID    string  `json:"areaId"`
	Name      string  `json:"name"`
	Color     *string `json:"color,omitempty"`
	SortOrder int     `json:"sortOrder"`
}

// UpdateProjectInput carries partial updates; nil fields are left unchanged. Archived
// toggles the archived_at timestamp.
type UpdateProjectInput struct {
	AreaID    *string `json:"areaId,omitempty"`
	Name      *string `json:"name,omitempty"`
	Color     *string `json:"color,omitempty"`
	SortOrder *int    `json:"sortOrder,omitempty"`
	Archived  *bool   `json:"archived,omitempty"`
}

// Create inserts a new project (UUIDv7 id, version 0, dirty).
func (r *ProjectsRepo) Create(in CreateProjectInput) (*domain.Project, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return nil, fmt.Errorf("generate uuid: %w", err)
	}
	now := r.clock.Now().UTC()
	// A new project lands at the end of its area. Callers that supply an explicit order
	// keep it; the UI passes none, so we assign the next slot within the area.
	order := in.SortOrder
	if order == 0 {
		if order, err = r.nextOrder(in.AreaID); err != nil {
			return nil, err
		}
	}
	p := &domain.Project{
		ID: id.String(), AreaID: in.AreaID, Name: in.Name, Color: in.Color, SortOrder: order,
		CreatedAt: now, UpdatedAt: now, Version: 0, Dirty: true,
	}
	if err := p.Validate(); err != nil {
		return nil, err
	}
	if _, err := r.db.Exec(
		`INSERT INTO projects (id, area_id, name, color, sort_order, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
		p.ID, p.AreaID, p.Name, p.Color, p.SortOrder,
		p.CreatedAt.Format(timeFormat), p.UpdatedAt.Format(timeFormat), p.Version, boolToInt(p.Dirty),
	); err != nil {
		return nil, fmt.Errorf("insert project: %w", err)
	}
	return p, nil
}

// nextOrder returns the sort_order for a new project appended after existing ones in its
// area (project order is scoped to the area — PLAN §6.6).
func (r *ProjectsRepo) nextOrder(areaID string) (int, error) {
	rows, err := r.db.Query(
		`SELECT COALESCE(MAX(sort_order), -1) + 1 FROM projects WHERE area_id = ? AND deleted_at IS NULL;`, areaID)
	if err != nil {
		return 0, fmt.Errorf("next project order: %w", err)
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

// Reorder assigns sort_order = position for each id in `ids` within the given area, only
// touching rows that belong to it. Bumps updated_at and marks each dirty so the order
// syncs (PLAN §6.6). Used by the sidebar / home drag-and-drop.
func (r *ProjectsRepo) Reorder(areaID string, ids []string) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	for i, id := range ids {
		if _, err := r.db.Exec(
			`UPDATE projects SET sort_order = ?, updated_at = ?, dirty = 1 WHERE id = ? AND area_id = ? AND deleted_at IS NULL;`,
			i, now, id, areaID,
		); err != nil {
			return fmt.Errorf("reorder projects: %w", err)
		}
	}
	return nil
}

// Get returns a single non-deleted project by id, or ErrNotFound.
func (r *ProjectsRepo) Get(id string) (*domain.Project, error) {
	rows, err := r.db.Query(`SELECT `+projectColumns+` FROM projects WHERE id = ? AND deleted_at IS NULL;`, id)
	if err != nil {
		return nil, fmt.Errorf("query project: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanProject(rows)
}

// List returns all non-deleted projects, by sort_order then name.
func (r *ProjectsRepo) List() ([]*domain.Project, error) {
	rows, err := r.db.Query(
		`SELECT ` + projectColumns + ` FROM projects WHERE deleted_at IS NULL ORDER BY sort_order, name, id;`)
	if err != nil {
		return nil, fmt.Errorf("query projects: %w", err)
	}
	defer rows.Close()
	out := []*domain.Project{}
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// Update applies partial changes, bumps updated_at, marks dirty.
func (r *ProjectsRepo) Update(id string, in UpdateProjectInput) (*domain.Project, error) {
	p, err := r.Get(id)
	if err != nil {
		return nil, err
	}
	if in.AreaID != nil {
		p.AreaID = *in.AreaID
	}
	if in.Name != nil {
		p.Name = *in.Name
	}
	if in.Color != nil {
		p.Color = in.Color
	}
	if in.SortOrder != nil {
		p.SortOrder = *in.SortOrder
	}
	if in.Archived != nil {
		if *in.Archived {
			now := r.clock.Now().UTC()
			p.ArchivedAt = &now
		} else {
			p.ArchivedAt = nil
		}
	}
	p.UpdatedAt = r.clock.Now().UTC()
	p.Dirty = true
	if err := p.Validate(); err != nil {
		return nil, err
	}
	var archivedAt any
	if p.ArchivedAt != nil {
		archivedAt = p.ArchivedAt.UTC().Format(timeFormat)
	}
	res, err := r.db.Exec(
		`UPDATE projects SET area_id = ?, name = ?, color = ?, sort_order = ?, archived_at = ?,
		   updated_at = ?, dirty = 1
		 WHERE id = ? AND deleted_at IS NULL;`,
		p.AreaID, p.Name, p.Color, p.SortOrder, archivedAt, p.UpdatedAt.Format(timeFormat), id,
	)
	if err != nil {
		return nil, fmt.Errorf("update project: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return nil, ErrNotFound
	}
	return p, nil
}

// Delete soft-deletes a project. Its project_members are tombstoned by the caller
// (nav/bridge) if desired; member entities are never touched (PLAN §6.6).
func (r *ProjectsRepo) Delete(id string) error {
	now := r.clock.Now().UTC()
	res, err := r.db.Exec(
		`UPDATE projects SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ? AND deleted_at IS NULL;`,
		now.Format(timeFormat), now.Format(timeFormat), id,
	)
	if err != nil {
		return fmt.Errorf("delete project: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	return nil
}

// --- SyncableRepo[*domain.Project] ----------------------------------------

func (r *ProjectsRepo) EntityType() string { return protocol.EntityProject }

func (r *ProjectsRepo) Dirty() ([]*domain.Project, error) {
	rows, err := r.db.Query(`SELECT ` + projectColumns + ` FROM projects WHERE dirty = 1 ORDER BY updated_at ASC, id ASC;`)
	if err != nil {
		return nil, fmt.Errorf("query dirty projects: %w", err)
	}
	defer rows.Close()
	out := []*domain.Project{}
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (r *ProjectsRepo) GetAny(id string) (*domain.Project, error) {
	rows, err := r.db.Query(`SELECT `+projectColumns+` FROM projects WHERE id = ?;`, id)
	if err != nil {
		return nil, fmt.Errorf("query project: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanProject(rows)
}

func (r *ProjectsRepo) Apply(p *domain.Project) error {
	var deletedAt, archivedAt any
	if p.DeletedAt != nil {
		deletedAt = p.DeletedAt.UTC().Format(timeFormat)
	}
	if p.ArchivedAt != nil {
		archivedAt = p.ArchivedAt.UTC().Format(timeFormat)
	}
	_, err := r.db.Exec(
		`INSERT INTO projects (id, area_id, name, color, sort_order, archived_at, created_at, updated_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   area_id = excluded.area_id, name = excluded.name, color = excluded.color,
		   sort_order = excluded.sort_order, archived_at = excluded.archived_at,
		   created_at = excluded.created_at, updated_at = excluded.updated_at,
		   deleted_at = excluded.deleted_at, version = excluded.version, dirty = 0;`,
		p.ID, p.AreaID, p.Name, p.Color, p.SortOrder, archivedAt,
		p.CreatedAt.UTC().Format(timeFormat), p.UpdatedAt.UTC().Format(timeFormat), deletedAt, p.Version,
	)
	if err != nil {
		return fmt.Errorf("apply project: %w", err)
	}
	return nil
}

func (r *ProjectsRepo) MarkPushed(id string, version int64) error {
	if _, err := r.db.Exec(`UPDATE projects SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark pushed: %w", err)
	}
	return nil
}

func (r *ProjectsRepo) MeaningfulDiff(a, b *domain.Project) bool {
	if a.AreaID != b.AreaID || a.Name != b.Name || derefStr(a.Color) != derefStr(b.Color) || a.SortOrder != b.SortOrder {
		return true
	}
	if (a.ArchivedAt == nil) != (b.ArchivedAt == nil) {
		return true
	}
	return (a.DeletedAt == nil) != (b.DeletedAt == nil)
}

func (r *ProjectsRepo) Decode(raw json.RawMessage) (*domain.Project, error) {
	var p domain.Project
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("decode project: %w", err)
	}
	return &p, nil
}

// ConflictedCopy forks a losing local project into a fresh row (§7.3).
func (r *ProjectsRepo) ConflictedCopy(local *domain.Project, suffix string) error {
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
		`INSERT INTO projects (id, area_id, name, color, sort_order, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1);`,
		id.String(), local.AreaID, name+" "+suffix, local.Color, local.SortOrder,
		now.Format(timeFormat), now.Format(timeFormat),
	)
	if err != nil {
		return fmt.Errorf("insert conflicted project: %w", err)
	}
	return nil
}

func scanProject(rows Rows) (*domain.Project, error) {
	var (
		p                            domain.Project
		color, deletedAt, archivedAt sql.NullString
		createdAt, updatedAt         string
		dirty                        int
	)
	if err := rows.Scan(&p.ID, &p.AreaID, &p.Name, &color, &p.SortOrder, &archivedAt, &createdAt, &updatedAt, &deletedAt, &p.Version, &dirty); err != nil {
		return nil, fmt.Errorf("scan project: %w", err)
	}
	if color.Valid {
		p.Color = &color.String
	}
	var err error
	if p.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if p.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	if archivedAt.Valid {
		t, err := time.Parse(timeFormat, archivedAt.String)
		if err != nil {
			return nil, fmt.Errorf("parse archived_at: %w", err)
		}
		p.ArchivedAt = &t
	}
	if deletedAt.Valid {
		t, err := time.Parse(timeFormat, deletedAt.String)
		if err != nil {
			return nil, fmt.Errorf("parse deleted_at: %w", err)
		}
		p.DeletedAt = &t
	}
	p.Dirty = dirty != 0
	return &p, nil
}
