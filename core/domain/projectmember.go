package domain

import (
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
)

// memberNamespace seeds the deterministic membership id below — a fixed UUID so the id
// depends only on the (project, entity) tuple, never the machine that generated it.
var memberNamespace = uuid.MustParse("b6f6c0de-0000-5000-a000-000000000001")

// MemberID derives a stable UUIDv5 from a (project, entityType, entity) tuple, so the same
// membership added independently on two devices — or generated on the server for a repeat
// occurrence — produces the *same* id and converges to one row on sync (PLAN §6.6). Shared by
// the client store and the server's repeat materializer.
func MemberID(projectID, entityType, entityID string) string {
	return uuid.NewSHA1(memberNamespace, []byte(projectID+"\x00"+entityType+"\x00"+entityID)).String()
}

// Calendar member types (PLAN §6.6, "Calendars"). A project can hold calendars as well as
// content: one calendar — a CalDAV collection or an ICS subscription, both CalendarFeed rows —
// or a whole CalendarAccount, which brings every calendar the account has, including ones a
// later rescan finds.
const (
	MemberCalendar        = "calendar"
	MemberCalendarAccount = "calendar_account"
)

// IsCalendarMember reports whether a member type is a calendar rather than content. Calendar
// memberships are not graph edges (calendars are not nodes, the same call canvasRefIndexed
// makes for events) and are never trashed with their project's content.
func IsCalendarMember(entityType string) bool {
	return entityType == MemberCalendar || entityType == MemberCalendarAccount
}

// ProjectMember is an AUTHORED edge: a synced many-to-many row joining a project to a
// note, task, habit, canvas or calendar (PLAN §4.0/§4.1). Content memberships are
// mirrored into the local `links` index as `member` edges (source = project, target = the
// member entity) so read-side graph queries hit one table; calendar memberships are not.
// An entity can belong to many projects.
type ProjectMember struct {
	ID         string     `json:"id"`
	ProjectID  string     `json:"projectId"`
	EntityType string     `json:"entityType"` // 'note' | 'task' | 'habit' | 'canvas' | 'calendar' | 'calendar_account'
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
var MemberEntityTypes = map[string]bool{
	NodeNote: true, NodeTask: true, NodeHabit: true, NodeCanvas: true,
	MemberCalendar: true, MemberCalendarAccount: true,
}

// Validate checks the invariants that must hold before a membership is persisted.
func (m *ProjectMember) Validate() error {
	if strings.TrimSpace(m.ID) == "" {
		return errors.Join(ErrInvalidProjectMember, errors.New("id is required"))
	}
	if strings.TrimSpace(m.ProjectID) == "" {
		return errors.Join(ErrInvalidProjectMember, errors.New("projectId is required"))
	}
	if !MemberEntityTypes[m.EntityType] {
		return errors.Join(ErrInvalidProjectMember, errors.New("entityType must be note, task, habit, canvas, calendar, or calendar_account"))
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
