package domain

import (
	"errors"
	"strings"
	"time"
)

// Project collects notes, tasks, and habits and drives the sidebar navigation. A
// project belongs to exactly ONE area (AreaID is a plain column, not an edge table —
// PLAN §4.0/§6.6), so the "only one area" invariant is structural. A dangling AreaID
// (its area was deleted) is tolerated: the project renders under "Unsorted".
type Project struct {
	ID         string     `json:"id"`
	AreaID     string     `json:"areaId"`
	Name       string     `json:"name"`
	Color      *string    `json:"color,omitempty"`
	SortOrder  int        `json:"sortOrder"`
	ArchivedAt *time.Time `json:"archivedAt,omitempty"`
	CreatedAt  time.Time  `json:"createdAt"`
	UpdatedAt  time.Time  `json:"updatedAt"`
	DeletedAt  *time.Time `json:"deletedAt,omitempty"`
	Version    int64      `json:"version"`
	Dirty      bool       `json:"dirty"`
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
	return nil
}

// SyncEntity implementation (PLAN §7).
func (p *Project) SyncID() string           { return p.ID }
func (p *Project) SyncVersion() int64       { return p.Version }
func (p *Project) SyncUpdatedAt() time.Time { return p.UpdatedAt }
func (p *Project) SyncDeleted() bool        { return p.DeletedAt != nil }
func (p *Project) SyncDirty() bool          { return p.Dirty }
