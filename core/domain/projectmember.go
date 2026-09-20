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

// Container kinds a membership row can name (PLAN-areas.md §2). A row without one is a
// project's — every row written before areas held content, and every row an older client
// still writes.
const (
	ContainerProject = "project"
	ContainerArea    = "area"
)

// AreaMemberEntityTypes are the entity kinds an area can hold directly: notes, tasks and
// canvases — never lists or calendars, which stay project-scoped (PLAN-areas.md §2).
var AreaMemberEntityTypes = map[string]bool{NodeNote: true, NodeTask: true, NodeCanvas: true}

// SingleContainer reports whether an entity type lives in at most ONE container — one area
// or one project, never both and never several (PLAN-areas.md §2.1). That is every content
// type; a calendar can still be filed in several projects.
func SingleContainer(entityType string) bool { return !IsCalendarMember(entityType) }

// ProjectMember is an AUTHORED edge: a synced row filing a note, task, habit, canvas or
// calendar in a container — a project, or (for notes, tasks and canvases) an area
// (PLAN §4.0/§4.1, PLAN-areas.md §2). Project content memberships are mirrored into the
// local `links` index as `member` edges (source = project, target = the member entity) so
// read-side graph queries hit one table; calendar and area memberships are not (neither a
// calendar nor an area is a graph node). A content entity has at most one live membership.
//
// ProjectID holds the CONTAINER's id: a project's, or an area's when ContainerType is
// 'area'. The field and its column keep their names for wire compatibility — an older
// client reads an area row as a membership of a project it doesn't know and ignores it.
type ProjectMember struct {
	ID            string     `json:"id"`
	ProjectID     string     `json:"projectId"`
	ContainerType string     `json:"containerType,omitempty"` // 'project' (default) | 'area'
	EntityType    string     `json:"entityType"`              // 'note' | 'task' | 'habit' | 'canvas' | 'calendar' | 'calendar_account'
	EntityID      string     `json:"entityId"`
	CreatedAt     time.Time  `json:"createdAt"`
	UpdatedAt     time.Time  `json:"updatedAt"`
	DeletedAt     *time.Time `json:"deletedAt,omitempty"`
	Version       int64      `json:"version"`
	Dirty         bool       `json:"dirty"`
}

// Container returns the row's container kind, reading an absent one as a project.
func (m *ProjectMember) Container() string {
	if m.ContainerType == ContainerArea {
		return ContainerArea
	}
	return ContainerProject
}

// InArea reports whether the row files its entity directly in an area.
func (m *ProjectMember) InArea() bool { return m.ContainerType == ContainerArea }

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
	if m.ContainerType != "" && m.ContainerType != ContainerProject && m.ContainerType != ContainerArea {
		return errors.Join(ErrInvalidProjectMember, errors.New("containerType must be project or area"))
	}
	if m.InArea() && !AreaMemberEntityTypes[m.EntityType] {
		return errors.Join(ErrInvalidProjectMember, errors.New("an area holds only notes, tasks and canvases"))
	}
	return nil
}

// SyncEntity implementation (PLAN §7).
func (m *ProjectMember) SyncID() string           { return m.ID }
func (m *ProjectMember) SyncVersion() int64       { return m.Version }
func (m *ProjectMember) SyncUpdatedAt() time.Time { return m.UpdatedAt }
func (m *ProjectMember) SyncDeleted() bool        { return m.DeletedAt != nil }
func (m *ProjectMember) SyncDirty() bool          { return m.Dirty }
