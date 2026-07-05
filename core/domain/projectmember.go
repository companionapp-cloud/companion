package domain

import (
	"errors"
	"strings"
	"time"
)

// ProjectMember is an AUTHORED edge: a synced many-to-many row joining a project to a
// note, task, or habit (PLAN §4.0/§4.1). It is mirrored into the local `links` index as
// a `member` edge (source = project, target = the member entity) so read-side graph
// queries hit one table. A note/task/habit can belong to many projects.
type ProjectMember struct {
	ID         string     `json:"id"`
	ProjectID  string     `json:"projectId"`
	EntityType string     `json:"entityType"` // 'note' | 'task' | 'habit'
	EntityID   string     `json:"entityId"`
	CreatedAt  time.Time  `json:"createdAt"`
	UpdatedAt  time.Time  `json:"updatedAt"`
	DeletedAt  *time.Time `json:"deletedAt,omitempty"`
	Version    int64      `json:"version"`
	Dirty      bool       `json:"dirty"`
}

// ErrInvalidProjectMember is returned when a membership row fails validation.
var ErrInvalidProjectMember = errors.New("invalid project member")

// MemberEntityTypes are the entity kinds a project can contain.
var MemberEntityTypes = map[string]bool{NodeNote: true, NodeTask: true, NodeHabit: true}

// Validate checks the invariants that must hold before a membership is persisted.
func (m *ProjectMember) Validate() error {
	if strings.TrimSpace(m.ID) == "" {
		return errors.Join(ErrInvalidProjectMember, errors.New("id is required"))
	}
	if strings.TrimSpace(m.ProjectID) == "" {
		return errors.Join(ErrInvalidProjectMember, errors.New("projectId is required"))
	}
	if !MemberEntityTypes[m.EntityType] {
		return errors.Join(ErrInvalidProjectMember, errors.New("entityType must be note, task, or habit"))
	}
	if strings.TrimSpace(m.EntityID) == "" {
		return errors.Join(ErrInvalidProjectMember, errors.New("entityId is required"))
	}
	return nil
}

// SyncEntity implementation (PLAN §7).
func (m *ProjectMember) SyncID() string           { return m.ID }
func (m *ProjectMember) SyncVersion() int64       { return m.Version }
func (m *ProjectMember) SyncUpdatedAt() time.Time { return m.UpdatedAt }
func (m *ProjectMember) SyncDeleted() bool        { return m.DeletedAt != nil }
func (m *ProjectMember) SyncDirty() bool          { return m.Dirty }
