package domain

import (
	"errors"
	"strings"
	"time"
)

// Area is a flat, ordered "area of your life" that groups projects and renders as a
// sidebar heading (PLAN §4.0, §6.6). Areas are organizational scaffolding, not graph
// nodes — a project's area is a column, not an edge. An area is also a page
// (PLAN-areas.md): it carries an optional emoji icon, cover image and markdown description,
// and holds notes, tasks and canvases directly through area-typed memberships.
type Area struct {
	ID    string  `json:"id"`
	Name  string  `json:"name"`
	Color *string `json:"color,omitempty"`
	// Icon is a single emoji shown beside the name; CoverDocumentID names the documents row
	// whose image heads the overview; DescriptionMd is the overview's rich text.
	Icon            *string    `json:"icon,omitempty"`
	CoverDocumentID *string    `json:"coverDocumentId,omitempty"`
	DescriptionMd   string     `json:"descriptionMd"`
	SortOrder       int        `json:"sortOrder"`
	CreatedAt       time.Time  `json:"createdAt"`
	UpdatedAt       time.Time  `json:"updatedAt"`
	DeletedAt       *time.Time `json:"deletedAt,omitempty"`
	Version         int64      `json:"version"`
	Dirty           bool       `json:"dirty"`
}

// ErrInvalidArea is returned when an area fails validation.
var ErrInvalidArea = errors.New("invalid area")

// Validate checks the invariants that must hold before an area is persisted.
func (a *Area) Validate() error {
	if strings.TrimSpace(a.ID) == "" {
		return errors.Join(ErrInvalidArea, errors.New("id is required"))
	}
	if strings.TrimSpace(a.Name) == "" {
		return errors.Join(ErrInvalidArea, errors.New("name is required"))
	}
	return nil
}

// SyncEntity implementation (PLAN §7).
func (a *Area) SyncID() string           { return a.ID }
func (a *Area) SyncVersion() int64       { return a.Version }
func (a *Area) SyncUpdatedAt() time.Time { return a.UpdatedAt }
func (a *Area) SyncDeleted() bool        { return a.DeletedAt != nil }
func (a *Area) SyncDirty() bool          { return a.Dirty }
