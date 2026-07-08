package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"companion/core/domain"
	"companion/core/sync/protocol"
)

// ProjectMembersRepo owns project membership (PLAN §4.1, §6.6): an authored, synced
// edge joining a project to a note/task/habit, mirrored into the local `links` index
// as a `member` edge on every write and sync-apply.
type ProjectMembersRepo struct {
	db    Driver
	clock domain.Clock
	links *LinksRepo
}

// memberID derives the stable UUIDv5 membership id — see domain.MemberID, shared with the
// server so a server-generated occurrence's memberships converge with the client's.
func memberID(projectID, entityType, entityID string) string {
	return domain.MemberID(projectID, entityType, entityID)
}

const memberColumns = `id, project_id, entity_type, entity_id, created_at, updated_at, deleted_at, version, dirty`

// Add makes an entity a member of a project (idempotent). A tombstoned membership for
// the same tuple is revived rather than duplicated.
func (r *ProjectMembersRepo) Add(projectID, entityType, entityID string) (*domain.ProjectMember, error) {
	now := r.clock.Now().UTC()
	m := &domain.ProjectMember{
		ID: memberID(projectID, entityType, entityID), ProjectID: projectID,
		EntityType: entityType, EntityID: entityID,
		CreatedAt: now, UpdatedAt: now, Version: 0, Dirty: true,
	}
	if err := m.Validate(); err != nil {
		return nil, err
	}
	existing, err := r.GetAny(m.ID)
	switch {
	case err == nil && existing.DeletedAt == nil:
		return existing, nil // already a member
	case err == nil:
		// Revive the tombstone in place (keeps its version for the next push).
		if _, err := r.db.Exec(
			`UPDATE project_members SET deleted_at = NULL, updated_at = ?, dirty = 1 WHERE id = ?;`,
			now.Format(timeFormat), m.ID); err != nil {
			return nil, fmt.Errorf("revive member: %w", err)
		}
		existing.DeletedAt = nil
		existing.UpdatedAt = now
		existing.Dirty = true
		m = existing
	case errors.Is(err, ErrNotFound):
		if _, err := r.db.Exec(
			`INSERT INTO project_members (id, project_id, entity_type, entity_id, created_at, updated_at, version, dirty)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
			m.ID, m.ProjectID, m.EntityType, m.EntityID,
			m.CreatedAt.Format(timeFormat), m.UpdatedAt.Format(timeFormat), m.Version, boolToInt(m.Dirty),
		); err != nil {
			return nil, fmt.Errorf("insert member: %w", err)
		}
	default:
		return nil, err
	}
	if err := r.links.AddEdge(domain.NodeProject, projectID, entityType, entityID, domain.KindMember); err != nil {
		return nil, err
	}
	return m, nil
}

// Remove soft-deletes a membership (idempotent) and drops its mirrored edge.
func (r *ProjectMembersRepo) Remove(projectID, entityType, entityID string) error {
	id := memberID(projectID, entityType, entityID)
	now := r.clock.Now().UTC()
	res, err := r.db.Exec(
		`UPDATE project_members SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ? AND deleted_at IS NULL;`,
		now.Format(timeFormat), now.Format(timeFormat), id,
	)
	if err != nil {
		return fmt.Errorf("remove member: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	return r.links.DeleteEdge(domain.NodeProject, projectID, entityType, entityID, domain.KindMember)
}

// ListForProject returns a project's live members.
func (r *ProjectMembersRepo) ListForProject(projectID string) ([]*domain.ProjectMember, error) {
	return r.list(`SELECT `+memberColumns+` FROM project_members
		WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at, id;`, projectID)
}

// ListForEntity returns the live memberships of one entity (which projects it's in).
func (r *ProjectMembersRepo) ListForEntity(entityType, entityID string) ([]*domain.ProjectMember, error) {
	return r.list(`SELECT `+memberColumns+` FROM project_members
		WHERE entity_type = ? AND entity_id = ? AND deleted_at IS NULL ORDER BY created_at, id;`, entityType, entityID)
}

// MemberEntityIDs returns the distinct ids of entities of a type that belong to at least one
// live project — the "sorted" entities. The browse lists subtract this set to offer
// "Unsorted" (entities in no project) alongside "All" (PLAN §6.6).
func (r *ProjectMembersRepo) MemberEntityIDs(entityType string) ([]string, error) {
	rows, err := r.db.Query(
		`SELECT DISTINCT entity_id FROM project_members WHERE entity_type = ? AND deleted_at IS NULL;`, entityType)
	if err != nil {
		return nil, fmt.Errorf("query member entity ids: %w", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// DeleteForProject tombstones every live membership of a project (used when the project
// itself is deleted — PLAN §6.6). Member entities are never touched.
func (r *ProjectMembersRepo) DeleteForProject(projectID string) error {
	members, err := r.ListForProject(projectID)
	if err != nil {
		return err
	}
	for _, m := range members {
		if err := r.Remove(m.ProjectID, m.EntityType, m.EntityID); err != nil {
			return err
		}
	}
	return nil
}

func (r *ProjectMembersRepo) list(query string, args ...any) ([]*domain.ProjectMember, error) {
	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query members: %w", err)
	}
	defer rows.Close()
	out := []*domain.ProjectMember{}
	for rows.Next() {
		m, err := scanMember(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// --- SyncableRepo[*domain.ProjectMember] ----------------------------------

func (r *ProjectMembersRepo) EntityType() string { return protocol.EntityProjectMember }

func (r *ProjectMembersRepo) Dirty() ([]*domain.ProjectMember, error) {
	return r.list(`SELECT ` + memberColumns + ` FROM project_members WHERE dirty = 1 ORDER BY updated_at ASC, id ASC;`)
}

func (r *ProjectMembersRepo) GetAny(id string) (*domain.ProjectMember, error) {
	rows, err := r.db.Query(`SELECT `+memberColumns+` FROM project_members WHERE id = ?;`, id)
	if err != nil {
		return nil, fmt.Errorf("query member: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanMember(rows)
}

func (r *ProjectMembersRepo) Apply(m *domain.ProjectMember) error {
	var deletedAt any
	if m.DeletedAt != nil {
		deletedAt = m.DeletedAt.UTC().Format(timeFormat)
	}
	_, err := r.db.Exec(
		`INSERT INTO project_members (id, project_id, entity_type, entity_id, created_at, updated_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   project_id = excluded.project_id, entity_type = excluded.entity_type,
		   entity_id = excluded.entity_id, created_at = excluded.created_at,
		   updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
		   version = excluded.version, dirty = 0;`,
		m.ID, m.ProjectID, m.EntityType, m.EntityID,
		m.CreatedAt.UTC().Format(timeFormat), m.UpdatedAt.UTC().Format(timeFormat), deletedAt, m.Version,
	)
	if err != nil {
		return fmt.Errorf("apply member: %w", err)
	}
	// Mirror the authored edge to match the applied state (PLAN §5.1).
	if m.DeletedAt != nil {
		return r.links.DeleteEdge(domain.NodeProject, m.ProjectID, m.EntityType, m.EntityID, domain.KindMember)
	}
	return r.links.AddEdge(domain.NodeProject, m.ProjectID, m.EntityType, m.EntityID, domain.KindMember)
}

func (r *ProjectMembersRepo) MarkPushed(id string, version int64) error {
	if _, err := r.db.Exec(`UPDATE project_members SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark pushed: %w", err)
	}
	return nil
}

// MeaningfulDiff is always false: a membership is an immutable tuple whose only state
// is alive-vs-deleted, and its id is derived from that tuple, so there is nothing to
// fork into a conflicted copy — last-write-wins on the deleted flag converges.
func (r *ProjectMembersRepo) MeaningfulDiff(a, b *domain.ProjectMember) bool { return false }

// ConflictedCopy is a no-op (never invoked, since MeaningfulDiff is always false).
func (r *ProjectMembersRepo) ConflictedCopy(local *domain.ProjectMember, suffix string) error {
	return nil
}

func (r *ProjectMembersRepo) Decode(raw json.RawMessage) (*domain.ProjectMember, error) {
	var m domain.ProjectMember
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("decode member: %w", err)
	}
	return &m, nil
}

func scanMember(rows Rows) (*domain.ProjectMember, error) {
	var (
		m                    domain.ProjectMember
		deletedAt            sql.NullString
		createdAt, updatedAt string
		dirty                int
	)
	if err := rows.Scan(&m.ID, &m.ProjectID, &m.EntityType, &m.EntityID, &createdAt, &updatedAt, &deletedAt, &m.Version, &dirty); err != nil {
		return nil, fmt.Errorf("scan member: %w", err)
	}
	var err error
	if m.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if m.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	if deletedAt.Valid {
		t, err := time.Parse(timeFormat, deletedAt.String)
		if err != nil {
			return nil, fmt.Errorf("parse deleted_at: %w", err)
		}
		m.DeletedAt = &t
	}
	m.Dirty = dirty != 0
	return &m, nil
}
