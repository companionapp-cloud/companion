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

// ProjectMembersRepo owns container membership (PLAN §4.1, §6.6, PLAN-areas.md §2): an
// authored, synced row filing a note/task/habit/canvas in a project — mirrored into the local
// `links` index as a `member` edge on every write and sync-apply — or filing a note/task/canvas
// directly in an area, or a calendar in a project, neither of which is mirrored (see
// memberIndexed).
//
// Content lives in ONE place (PLAN-areas.md §2.1): filing a content entity somewhere moves it,
// tombstoning whatever membership it had. Two devices can still file the same entity in two
// places before they sync, so EnforceSingleContainer settles those after every pull.
type ProjectMembersRepo struct {
	db    Driver
	clock domain.Clock
	links *LinksRepo
	// listItems lets a task leaving a project leave that project's lists with it.
	listItems *ListItemsRepo
}

// memberID derives the stable UUIDv5 membership id — see domain.MemberID, shared with the
// server so a server-generated occurrence's memberships converge with the client's.
func memberID(projectID, entityType, entityID string) string {
	return domain.MemberID(projectID, entityType, entityID)
}

const memberColumns = `id, project_id, container_type, entity_type, entity_id, created_at, updated_at, deleted_at, version, dirty`

// memberIndexed reports whether a membership is mirrored into the graph index. Neither a
// calendar nor an area is a graph node, so a `member` edge touching one would only ever draw
// as a ghost.
func memberIndexed(containerType, entityType string) bool {
	return containerType != domain.ContainerArea && !domain.IsCalendarMember(entityType)
}

// Add files an entity in a project (idempotent). A tombstoned membership for the same tuple
// is revived rather than duplicated. A content entity moves: the membership it had, in
// another project or an area, is tombstoned (PLAN-areas.md §2.1).
func (r *ProjectMembersRepo) Add(projectID, entityType, entityID string) (*domain.ProjectMember, error) {
	return r.add(domain.ContainerProject, projectID, entityType, entityID)
}

// AddToArea files a note, task or canvas directly in an area — Add's twin, with the same
// move semantics.
func (r *ProjectMembersRepo) AddToArea(areaID, entityType, entityID string) (*domain.ProjectMember, error) {
	return r.add(domain.ContainerArea, areaID, entityType, entityID)
}

func (r *ProjectMembersRepo) add(containerType, containerID, entityType, entityID string) (*domain.ProjectMember, error) {
	now := r.clock.Now().UTC()
	m := &domain.ProjectMember{
		ID: memberID(containerID, entityType, entityID), ProjectID: containerID, ContainerType: containerType,
		EntityType: entityType, EntityID: entityID,
		CreatedAt: now, UpdatedAt: now, Version: 0, Dirty: true,
	}
	if err := m.Validate(); err != nil {
		return nil, err
	}
	if domain.SingleContainer(entityType) {
		if err := r.displace(m.ID, entityType, entityID); err != nil {
			return nil, err
		}
	}
	existing, err := r.GetAny(m.ID)
	switch {
	case err == nil && existing.DeletedAt == nil:
		return existing, nil // already a member
	case err == nil:
		// Revive the tombstone in place (keeps its version for the next push).
		if _, err := r.db.Exec(
			`UPDATE project_members SET deleted_at = NULL, container_type = ?, updated_at = ?, dirty = 1 WHERE id = ?;`,
			containerType, now.Format(timeFormat), m.ID); err != nil {
			return nil, fmt.Errorf("revive member: %w", err)
		}
		existing.DeletedAt = nil
		existing.ContainerType = containerType
		existing.UpdatedAt = now
		existing.Dirty = true
		m = existing
	case errors.Is(err, ErrNotFound):
		if _, err := r.db.Exec(
			`INSERT INTO project_members (id, project_id, container_type, entity_type, entity_id, created_at, updated_at, version, dirty)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
			m.ID, m.ProjectID, m.ContainerType, m.EntityType, m.EntityID,
			m.CreatedAt.Format(timeFormat), m.UpdatedAt.Format(timeFormat), m.Version, boolToInt(m.Dirty),
		); err != nil {
			return nil, fmt.Errorf("insert member: %w", err)
		}
	default:
		return nil, err
	}
	if memberIndexed(containerType, entityType) {
		if err := r.links.AddEdge(domain.NodeProject, containerID, entityType, entityID, domain.KindMember); err != nil {
			return nil, err
		}
	}
	return m, nil
}

// displace tombstones every live membership of an entity except keepID — the "leave" half of
// a move.
func (r *ProjectMembersRepo) displace(keepID, entityType, entityID string) error {
	current, err := r.ListForEntity(entityType, entityID)
	if err != nil {
		return err
	}
	for _, old := range current {
		if old.ID == keepID {
			continue
		}
		if err := r.Remove(old.ProjectID, entityType, entityID); err != nil && !errors.Is(err, ErrNotFound) {
			return err
		}
	}
	return nil
}

// EnforceSingleContainer settles content entities filed in more than one place, keeping the
// membership each was given FIRST (earliest created_at, then lowest id) and tombstoning the
// rest (PLAN-areas.md §2.1). It is both the one-off migration from the many-projects model —
// run when the store opens — and the convergence step after a sync pull, where two devices
// may each have filed the same entity somewhere different. The rule reads only synced fields,
// so every device picks the same winner and pushes the same tombstones. It returns how many
// memberships it removed.
func (r *ProjectMembersRepo) EnforceSingleContainer() (int, error) {
	rows, err := r.list(
		`SELECT `+memberColumns+` FROM project_members pm
		  WHERE pm.deleted_at IS NULL AND pm.entity_type NOT IN (?, ?)
		    AND EXISTS (SELECT 1 FROM project_members o
		                 WHERE o.entity_type = pm.entity_type AND o.entity_id = pm.entity_id
		                   AND o.deleted_at IS NULL AND o.id <> pm.id);`,
		domain.MemberCalendar, domain.MemberCalendarAccount)
	if err != nil {
		return 0, err
	}
	type key struct{ entityType, entityID string }
	keep := map[key]*domain.ProjectMember{}
	for _, m := range rows {
		k := key{m.EntityType, m.EntityID}
		if w, ok := keep[k]; !ok || m.CreatedAt.Before(w.CreatedAt) || (m.CreatedAt.Equal(w.CreatedAt) && m.ID < w.ID) {
			keep[k] = m
		}
	}
	removed := 0
	for _, m := range rows {
		if keep[key{m.EntityType, m.EntityID}].ID == m.ID {
			continue
		}
		if err := r.Remove(m.ProjectID, m.EntityType, m.EntityID); err != nil && !errors.Is(err, ErrNotFound) {
			return removed, err
		}
		removed++
	}
	return removed, nil
}

// AddMany makes several entities members of one project (bulk multiselect "assign to
// project" — PLAN §6.6). Each add reuses Add, so the per-tuple revive/insert + edge-mirror
// logic is preserved and the call is idempotent; it returns the resulting memberships.
func (r *ProjectMembersRepo) AddMany(projectID, entityType string, entityIDs []string) ([]*domain.ProjectMember, error) {
	return r.addMany(domain.ContainerProject, projectID, entityType, entityIDs)
}

// AddManyToArea is AddMany for an area.
func (r *ProjectMembersRepo) AddManyToArea(areaID, entityType string, entityIDs []string) ([]*domain.ProjectMember, error) {
	return r.addMany(domain.ContainerArea, areaID, entityType, entityIDs)
}

func (r *ProjectMembersRepo) addMany(containerType, containerID, entityType string, entityIDs []string) ([]*domain.ProjectMember, error) {
	out := make([]*domain.ProjectMember, 0, len(entityIDs))
	for _, entityID := range entityIDs {
		m, err := r.add(containerType, containerID, entityType, entityID)
		if err != nil {
			return out, err
		}
		out = append(out, m)
	}
	return out, nil
}

// Remove soft-deletes a membership (idempotent) and drops its mirrored edge. The container is
// a project or an area — the id is derived from the tuple either way. A task leaving a project
// leaves that project's lists too, since a list only holds its project's tasks (PLAN §6.6).
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
	if entityType == domain.NodeTask && r.listItems != nil {
		if err := r.listItems.RemoveTaskFromProject(projectID, entityID); err != nil {
			return err
		}
	}
	if domain.IsCalendarMember(entityType) {
		return nil
	}
	// An area membership has no edge; deleting the one that isn't there is a no-op.
	return r.links.DeleteEdge(domain.NodeProject, projectID, entityType, entityID, domain.KindMember)
}

// Reassign moves every live membership of one entity to another of the same type: each project
// the old one belonged to gets the new one instead. Used when two rows turn out to be the same
// thing and one is dropped (a calendar a rescan found twice), so the projects keep it.
func (r *ProjectMembersRepo) Reassign(entityType, fromID, toID string) error {
	if fromID == toID {
		return nil
	}
	members, err := r.ListForEntity(entityType, fromID)
	if err != nil {
		return err
	}
	for _, m := range members {
		if _, err := r.Add(m.ProjectID, entityType, toID); err != nil {
			return err
		}
		if err := r.Remove(m.ProjectID, entityType, fromID); err != nil && !errors.Is(err, ErrNotFound) {
			return err
		}
	}
	return nil
}

// ListForProject returns a project's live members.
func (r *ProjectMembersRepo) ListForProject(projectID string) ([]*domain.ProjectMember, error) {
	return r.list(`SELECT `+memberColumns+` FROM project_members
		WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at, id;`, projectID)
}

// ListForArea returns the live members filed directly in an area (not its projects' members).
func (r *ProjectMembersRepo) ListForArea(areaID string) ([]*domain.ProjectMember, error) {
	return r.list(`SELECT `+memberColumns+` FROM project_members
		WHERE project_id = ? AND container_type = ? AND deleted_at IS NULL ORDER BY created_at, id;`,
		areaID, domain.ContainerArea)
}

// ListForAreaTree returns the live content members of an area AND of every live project in
// it — the roll-up an area's overview reads (PLAN-areas.md §3).
func (r *ProjectMembersRepo) ListForAreaTree(areaID string) ([]*domain.ProjectMember, error) {
	return r.list(`SELECT `+memberColumns+` FROM project_members
		WHERE deleted_at IS NULL AND entity_type NOT IN (?, ?)
		  AND ((container_type = ? AND project_id = ?)
		    OR (container_type <> ? AND project_id IN (SELECT id FROM projects WHERE area_id = ? AND deleted_at IS NULL AND completed_at IS NULL)))
		ORDER BY created_at, id;`,
		domain.MemberCalendar, domain.MemberCalendarAccount,
		domain.ContainerArea, areaID, domain.ContainerArea, areaID)
}

// ListForEntity returns the live memberships of one entity (which projects it's in).
func (r *ProjectMembersRepo) ListForEntity(entityType, entityID string) ([]*domain.ProjectMember, error) {
	return r.list(`SELECT `+memberColumns+` FROM project_members
		WHERE entity_type = ? AND entity_id = ? AND deleted_at IS NULL ORDER BY created_at, id;`, entityType, entityID)
}

// MemberEntityIDs returns the distinct ids of entities of a type that are filed somewhere — in
// a project or directly in an area — the "sorted" entities. The browse lists subtract this set to offer
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

// SomedayTaskIDs returns the ids of tasks filed in a live Someday project. They are filed away
// with it (PLAN-scheduling.md §1): out of every task list but the Someday filter and the
// project's own.
func (r *ProjectMembersRepo) SomedayTaskIDs() ([]string, error) {
	rows, err := r.db.Query(
		`SELECT DISTINCT m.entity_id FROM project_members m
		   JOIN projects p ON p.id = m.project_id
		  WHERE m.entity_type = ? AND m.container_type = ? AND m.deleted_at IS NULL
		    AND p.someday = 1 AND p.deleted_at IS NULL AND p.completed_at IS NULL;`,
		domain.NodeTask, domain.ContainerProject)
	if err != nil {
		return nil, fmt.Errorf("query someday task ids: %w", err)
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

// DeleteForProject tombstones every live membership of a container — a project, or an area's
// direct members — used when the container itself is deleted (PLAN §6.6). Member entities are
// never touched.
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

// Dirty returns the rows to push, tombstones FIRST. The server commits a push row by row, so
// another device can pull mid-push; with the "leave" half of every move ahead of its "join"
// half, that device sees the entity unfiled for a moment but never filed in two places — which
// EnforceSingleContainer would settle by undoing the move (PLAN-areas.md §2.1).
func (r *ProjectMembersRepo) Dirty() ([]*domain.ProjectMember, error) {
	return r.list(`SELECT ` + memberColumns + ` FROM project_members WHERE dirty = 1
		ORDER BY (deleted_at IS NULL) ASC, updated_at ASC, id ASC;`)
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
		`INSERT INTO project_members (id, project_id, container_type, entity_type, entity_id, created_at, updated_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   project_id = excluded.project_id, container_type = excluded.container_type,
		   entity_type = excluded.entity_type,
		   entity_id = excluded.entity_id, created_at = excluded.created_at,
		   updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
		   version = excluded.version, dirty = 0;`,
		m.ID, m.ProjectID, m.Container(), m.EntityType, m.EntityID,
		m.CreatedAt.UTC().Format(timeFormat), m.UpdatedAt.UTC().Format(timeFormat), deletedAt, m.Version,
	)
	if err != nil {
		return fmt.Errorf("apply member: %w", err)
	}
	// Mirror the authored edge to match the applied state (PLAN §5.1).
	if !memberIndexed(m.Container(), m.EntityType) {
		return nil
	}
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
	if err := rows.Scan(&m.ID, &m.ProjectID, &m.ContainerType, &m.EntityType, &m.EntityID, &createdAt, &updatedAt, &deletedAt, &m.Version, &dirty); err != nil {
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
