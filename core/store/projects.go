package store

import (
	"database/sql"
	"encoding/json"
	"errors"
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

const projectColumns = `id, area_id, name, color, icon, cover_document_id, description_md, sort_order, archived_at, created_at, updated_at, deleted_at, version, dirty, start_at, due_at, someday, completed_at, repeat_rule, repeat_after`

// CreateProjectInput carries the client-supplied fields for a new project.
type CreateProjectInput struct {
	AreaID          string  `json:"areaId"`
	Name            string  `json:"name"`
	Color           *string `json:"color,omitempty"`
	Icon            *string `json:"icon,omitempty"`
	CoverDocumentID *string `json:"coverDocumentId,omitempty"`
	DescriptionMd   string  `json:"descriptionMd,omitempty"`
	SortOrder       int     `json:"sortOrder"`
	// Scheduling (PLAN-scheduling.md §2). Someday wins over a StartAt supplied alongside it;
	// CompletedAt creates the project already finished (an import keeps when it was).
	StartAt     *time.Time `json:"startAt,omitempty"`
	DueAt       *time.Time `json:"dueAt,omitempty"`
	Someday     bool       `json:"someday,omitempty"`
	CompletedAt *time.Time `json:"completedAt,omitempty"`
}

// UpdateProjectInput carries partial updates; nil fields are left unchanged. Archived
// toggles the archived_at timestamp; an empty Icon or CoverDocumentID clears it
// (PLAN-areas.md §1).
type UpdateProjectInput struct {
	AreaID          *string `json:"areaId,omitempty"`
	Name            *string `json:"name,omitempty"`
	Color           *string `json:"color,omitempty"`
	Icon            *string `json:"icon,omitempty"`
	CoverDocumentID *string `json:"coverDocumentId,omitempty"`
	DescriptionMd   *string `json:"descriptionMd,omitempty"`
	SortOrder       *int    `json:"sortOrder,omitempty"`
	Archived        *bool   `json:"archived,omitempty"`
	// Scheduling (PLAN-scheduling.md §2), with a task's Clear-flag convention for the nullable
	// dates. Someday and a start exclude each other: setting one clears the other. Completed
	// stamps or clears completed_at; a completed project is archived too, which is what keeps
	// it out of the graph. RepeatRule and RepeatAfter exclude each other the same way.
	StartAt      *time.Time `json:"startAt,omitempty"`
	ClearStartAt bool       `json:"clearStartAt,omitempty"`
	DueAt        *time.Time `json:"dueAt,omitempty"`
	ClearDueAt   bool       `json:"clearDueAt,omitempty"`
	Someday      *bool      `json:"someday,omitempty"`
	Completed    *bool      `json:"completed,omitempty"`
	RepeatRule   *string    `json:"repeatRule,omitempty"`
	RepeatAfter  *string    `json:"repeatAfter,omitempty"`
	ClearRepeat  bool       `json:"clearRepeat,omitempty"`
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
		Icon: emptyToNil(in.Icon), CoverDocumentID: emptyToNil(in.CoverDocumentID), DescriptionMd: in.DescriptionMd,
		StartAt: utcTime(in.StartAt), DueAt: utcTime(in.DueAt), Someday: in.Someday, CompletedAt: utcTime(in.CompletedAt),
		CreatedAt: now, UpdatedAt: now, Version: 0, Dirty: true,
	}
	if p.Someday {
		p.StartAt = nil
	}
	if p.CompletedAt != nil {
		p.ArchivedAt = p.CompletedAt
	}
	if err := p.Validate(); err != nil {
		return nil, err
	}
	if _, err := r.db.Exec(
		`INSERT INTO projects (id, area_id, name, color, icon, cover_document_id, description_md, sort_order, archived_at, start_at, due_at, someday, completed_at, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
		p.ID, p.AreaID, p.Name, p.Color, p.Icon, p.CoverDocumentID, p.DescriptionMd, p.SortOrder,
		nullTime(p.ArchivedAt), nullTime(p.StartAt), nullTime(p.DueAt), boolToInt(p.Someday), nullTime(p.CompletedAt),
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

// CountForArea returns how many live, open projects belong to an area. Used to enforce that an
// area is only deletable once empty (PLAN §6.6). Completed projects don't hold an area open:
// they are out of sight in the Logbook, and tolerate a dangling area like any project.
func (r *ProjectsRepo) CountForArea(areaID string) (int, error) {
	rows, err := r.db.Query(`SELECT COUNT(*) FROM projects WHERE area_id = ? AND deleted_at IS NULL AND completed_at IS NULL;`, areaID)
	if err != nil {
		return 0, fmt.Errorf("count projects for area: %w", err)
	}
	defer rows.Close()
	n := 0
	if rows.Next() {
		if err := rows.Scan(&n); err != nil {
			return 0, err
		}
	}
	return n, rows.Err()
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
	if in.Icon != nil {
		p.Icon = emptyToNil(in.Icon)
	}
	if in.CoverDocumentID != nil {
		p.CoverDocumentID = emptyToNil(in.CoverDocumentID)
	}
	if in.DescriptionMd != nil {
		p.DescriptionMd = *in.DescriptionMd
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
	if in.StartAt != nil {
		p.StartAt = utcTime(in.StartAt)
		p.Someday = false
	} else if in.ClearStartAt {
		p.StartAt = nil
	}
	if in.DueAt != nil {
		p.DueAt = utcTime(in.DueAt)
	} else if in.ClearDueAt {
		p.DueAt = nil
	}
	if in.Someday != nil {
		p.Someday = *in.Someday
		if p.Someday {
			p.StartAt = nil
		}
	}
	if in.Completed != nil && *in.Completed != (p.CompletedAt != nil) {
		if *in.Completed {
			now := r.clock.Now().UTC()
			p.CompletedAt = &now
			if p.ArchivedAt == nil {
				p.ArchivedAt = &now
			}
		} else {
			p.CompletedAt = nil
			p.ArchivedAt = nil
		}
	}
	switch {
	case in.ClearRepeat:
		p.RepeatRule, p.RepeatAfter = nil, nil
	case in.RepeatRule != nil:
		p.RepeatRule, p.RepeatAfter = trimmedRule(in.RepeatRule), nil
	case in.RepeatAfter != nil:
		after, err := domain.ParseRepeatAfter(*in.RepeatAfter)
		if err != nil {
			return nil, errors.Join(domain.ErrInvalidProject, err)
		}
		canonical := after.String()
		p.RepeatRule, p.RepeatAfter = nil, &canonical
	}
	p.UpdatedAt = r.clock.Now().UTC()
	p.Dirty = true
	if err := p.Validate(); err != nil {
		return nil, err
	}
	res, err := r.db.Exec(
		`UPDATE projects SET area_id = ?, name = ?, color = ?, icon = ?, cover_document_id = ?,
		   description_md = ?, sort_order = ?, archived_at = ?, start_at = ?, due_at = ?, someday = ?,
		   completed_at = ?, repeat_rule = ?, repeat_after = ?, updated_at = ?, dirty = 1
		 WHERE id = ? AND deleted_at IS NULL;`,
		p.AreaID, p.Name, p.Color, p.Icon, p.CoverDocumentID, p.DescriptionMd, p.SortOrder, nullTime(p.ArchivedAt),
		nullTime(p.StartAt), nullTime(p.DueAt), boolToInt(p.Someday), nullTime(p.CompletedAt), p.RepeatRule, p.RepeatAfter,
		p.UpdatedAt.Format(timeFormat), id,
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
	_, err := r.db.Exec(
		`INSERT INTO projects (id, area_id, name, color, icon, cover_document_id, description_md, sort_order, archived_at,
		   start_at, due_at, someday, completed_at, repeat_rule, repeat_after, created_at, updated_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   area_id = excluded.area_id, name = excluded.name, color = excluded.color,
		   icon = excluded.icon, cover_document_id = excluded.cover_document_id,
		   description_md = excluded.description_md,
		   sort_order = excluded.sort_order, archived_at = excluded.archived_at,
		   start_at = excluded.start_at, due_at = excluded.due_at, someday = excluded.someday,
		   completed_at = excluded.completed_at, repeat_rule = excluded.repeat_rule,
		   repeat_after = excluded.repeat_after,
		   created_at = excluded.created_at, updated_at = excluded.updated_at,
		   deleted_at = excluded.deleted_at, version = excluded.version, dirty = 0;`,
		p.ID, p.AreaID, p.Name, p.Color, p.Icon, p.CoverDocumentID, p.DescriptionMd, p.SortOrder, nullTime(p.ArchivedAt),
		nullTime(p.StartAt), nullTime(p.DueAt), boolToInt(p.Someday), nullTime(p.CompletedAt), p.RepeatRule, p.RepeatAfter,
		p.CreatedAt.UTC().Format(timeFormat), p.UpdatedAt.UTC().Format(timeFormat), nullTime(p.DeletedAt), p.Version,
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
	if derefStr(a.Icon) != derefStr(b.Icon) || derefStr(a.CoverDocumentID) != derefStr(b.CoverDocumentID) || a.DescriptionMd != b.DescriptionMd {
		return true
	}
	if (a.ArchivedAt == nil) != (b.ArchivedAt == nil) || (a.CompletedAt == nil) != (b.CompletedAt == nil) {
		return true
	}
	if !sameTime(a.StartAt, b.StartAt) || !sameTime(a.DueAt, b.DueAt) || a.Someday != b.Someday {
		return true
	}
	if derefStr(a.RepeatRule) != derefStr(b.RepeatRule) || derefStr(a.RepeatAfter) != derefStr(b.RepeatAfter) {
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
		`INSERT INTO projects (id, area_id, name, color, icon, cover_document_id, description_md, sort_order, start_at, due_at, someday, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1);`,
		id.String(), local.AreaID, name+" "+suffix, local.Color, local.Icon, local.CoverDocumentID, local.DescriptionMd, local.SortOrder,
		nullTime(local.StartAt), nullTime(local.DueAt), boolToInt(local.Someday),
		now.Format(timeFormat), now.Format(timeFormat),
	)
	if err != nil {
		return fmt.Errorf("insert conflicted project: %w", err)
	}
	return nil
}

func scanProject(rows Rows) (*domain.Project, error) {
	var (
		p                                         domain.Project
		color, icon, cover, deletedAt, archivedAt sql.NullString
		startAt, dueAt, completedAt               sql.NullString
		repeatRule, repeatAfter                   sql.NullString
		createdAt, updatedAt                      string
		dirty, someday                            int
	)
	if err := rows.Scan(&p.ID, &p.AreaID, &p.Name, &color, &icon, &cover, &p.DescriptionMd, &p.SortOrder, &archivedAt, &createdAt, &updatedAt, &deletedAt, &p.Version, &dirty,
		&startAt, &dueAt, &someday, &completedAt, &repeatRule, &repeatAfter); err != nil {
		return nil, fmt.Errorf("scan project: %w", err)
	}
	if color.Valid {
		p.Color = &color.String
	}
	if icon.Valid && icon.String != "" {
		p.Icon = &icon.String
	}
	if cover.Valid && cover.String != "" {
		p.CoverDocumentID = &cover.String
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
	if p.StartAt, err = parseNullTime(startAt); err != nil {
		return nil, err
	}
	if p.DueAt, err = parseNullTime(dueAt); err != nil {
		return nil, err
	}
	if p.CompletedAt, err = parseNullTime(completedAt); err != nil {
		return nil, err
	}
	if repeatRule.Valid && repeatRule.String != "" {
		p.RepeatRule = &repeatRule.String
	}
	if repeatAfter.Valid && repeatAfter.String != "" {
		p.RepeatAfter = &repeatAfter.String
	}
	p.Someday = someday != 0
	p.Dirty = dirty != 0
	return &p, nil
}

// utcTime normalizes an optional instant to UTC, the form every timestamp column stores.
func utcTime(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	u := t.UTC()
	return &u
}
