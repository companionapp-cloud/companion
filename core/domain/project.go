package domain

import (
	"errors"
	"strings"
	"time"
)

// Project collects notes, tasks, and habits and drives the sidebar navigation. A
// project belongs to exactly ONE area (AreaID is a plain column, not an edge table —
// PLAN §4.0/§6.6), so the "only one area" invariant is structural. A dangling AreaID
// (its area was deleted) is tolerated: the project renders under "Unsorted". Like an area,
// a project is a page (PLAN-areas.md) with an optional emoji icon, cover image and markdown
// description.
type Project struct {
	ID              string     `json:"id"`
	AreaID          string     `json:"areaId"`
	Name            string     `json:"name"`
	Color           *string    `json:"color,omitempty"`
	Icon            *string    `json:"icon,omitempty"`
	CoverDocumentID *string    `json:"coverDocumentId,omitempty"`
	DescriptionMd   string     `json:"descriptionMd"`
	SortOrder       int        `json:"sortOrder"`
	ArchivedAt      *time.Time `json:"archivedAt,omitempty"`
	// StartAt / DueAt schedule the project exactly like a task's (DueAt is presented as
	// "Deadline"). A project with both spans those days on the calendar (PLAN-scheduling.md §2).
	StartAt *time.Time `json:"startAt,omitempty"`
	DueAt   *time.Time `json:"dueAt,omitempty"`
	// Someday stands in for a start: the project is filed away — off the sidebar, shown only
	// on its area's overview. It never coexists with a StartAt.
	Someday bool `json:"someday"`
	// CompletedAt marks the project finished: hidden everywhere but the Logbook.
	CompletedAt *time.Time `json:"completedAt,omitempty"`
	// RepeatRule (an RRULE, on a schedule) or RepeatAfter (an interval after completion, see
	// RepeatAfter) makes the project repeat; at most one is set. The server spawns the next
	// copy and moves the rule onto it, so only the newest copy of a chain carries one
	// (PLAN-scheduling.md §3).
	RepeatRule  *string    `json:"repeatRule,omitempty"`
	RepeatAfter *string    `json:"repeatAfter,omitempty"`
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
	DeletedAt   *time.Time `json:"deletedAt,omitempty"`
	Version     int64      `json:"version"`
	Dirty       bool       `json:"dirty"`
}

// ErrInvalidProject is returned when a project fails validation.
var ErrInvalidProject = errors.New("invalid project")

// Validate checks the invariants that must hold before a project is persisted.
func (p *Project) Validate() error {
	if strings.TrimSpace(p.ID) == "" {
		return errors.Join(ErrInvalidProject, errors.New("id is required"))
	}
	if strings.TrimSpace(p.AreaID) == "" {
		return errors.Join(ErrInvalidProject, errors.New("areaId is required"))
	}
	if strings.TrimSpace(p.Name) == "" {
		return errors.Join(ErrInvalidProject, errors.New("name is required"))
	}
	if p.Someday && p.StartAt != nil {
		return errors.Join(ErrInvalidProject, errors.New("a someday project has no start"))
	}
	if err := ValidateRepeatRule(p.RepeatRule); err != nil {
		return errors.Join(ErrInvalidProject, err)
	}
	if p.RepeatAfter != nil {
		if _, err := ParseRepeatAfter(*p.RepeatAfter); err != nil {
			return errors.Join(ErrInvalidProject, err)
		}
		if p.RepeatRule != nil {
			return errors.Join(ErrInvalidProject, errors.New("a project repeats on a schedule or after completion, not both"))
		}
	}
	return nil
}

// Repeats reports whether the project carries a repeat definition of either kind.
func (p *Project) Repeats() bool { return p.RepeatRule != nil || p.RepeatAfter != nil }

// ScheduleAnchor is the instant the project's schedule hangs off: its start, else its
// deadline, else nil. A repeat's next copy is placed by moving this instant.
func (p *Project) ScheduleAnchor() *time.Time {
	if p.StartAt != nil {
		return p.StartAt
	}
	return p.DueAt
}

// SyncEntity implementation (PLAN §7).
func (p *Project) SyncID() string           { return p.ID }
func (p *Project) SyncVersion() int64       { return p.Version }
func (p *Project) SyncUpdatedAt() time.Time { return p.UpdatedAt }
func (p *Project) SyncDeleted() bool        { return p.DeletedAt != nil }
func (p *Project) SyncDirty() bool          { return p.Dirty }
