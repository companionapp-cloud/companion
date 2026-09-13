package domain

import (
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
)

// List is a project-scoped, user-ordered collection of tasks (a "priority list"). A list
// belongs to exactly one project (ProjectID is a plain column, like a project's area) and
// orders its member tasks by drag-and-drop. Headings inside a list ("sublists") group the
// tasks beneath them; both tasks and headings are ListItems sharing one flat sort order, so
// a task's sublist is simply the nearest heading above it. Lists are organizational
// scaffolding like projects: they are never trashed and delete immediately.
type List struct {
	ID        string     `json:"id"`
	ProjectID string     `json:"projectId"`
	Name      string     `json:"name"`
	SortOrder int        `json:"sortOrder"`
	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt time.Time  `json:"updatedAt"`
	DeletedAt *time.Time `json:"deletedAt,omitempty"`
	Version   int64      `json:"version"`
	Dirty     bool       `json:"dirty"`
}

// ErrInvalidList is returned when a list fails validation.
var ErrInvalidList = errors.New("invalid list")

// Validate checks the invariants that must hold before a list is persisted.
func (l *List) Validate() error {
	if strings.TrimSpace(l.ID) == "" {
		return errors.Join(ErrInvalidList, errors.New("id is required"))
	}
	if strings.TrimSpace(l.ProjectID) == "" {
		return errors.Join(ErrInvalidList, errors.New("projectId is required"))
	}
	if strings.TrimSpace(l.Name) == "" {
		return errors.Join(ErrInvalidList, errors.New("name is required"))
	}
	return nil
}

// SyncEntity implementation (PLAN §7).
func (l *List) SyncID() string           { return l.ID }
func (l *List) SyncVersion() int64       { return l.Version }
func (l *List) SyncUpdatedAt() time.Time { return l.UpdatedAt }
func (l *List) SyncDeleted() bool        { return l.DeletedAt != nil }
func (l *List) SyncDirty() bool          { return l.Dirty }

// List item kinds: a task reference, or a heading that starts a sublist.
const (
	ListItemTask    = "task"
	ListItemHeading = "heading"
)

// listItemNamespace seeds the deterministic task-item id below — a fixed UUID so the id
// depends only on the (list, task) tuple, never the machine that generated it.
var listItemNamespace = uuid.MustParse("b6f6c0de-0000-5000-a000-000000000002")

// ListTaskItemID derives a stable UUIDv5 from a (list, task) tuple, so the same task added
// to the same list independently on two devices produces the *same* item row and converges
// on sync (mirrors MemberID for project membership). Headings get ordinary UUIDv7 ids.
func ListTaskItemID(listID, taskID string) string {
	return uuid.NewSHA1(listItemNamespace, []byte(listID+"\x00"+taskID)).String()
}

// ListItem is one row of a list: either a task reference (Kind "task", TaskID set) or a
// heading (Kind "heading", Title set) that groups the task items that follow it. Items
// share a single flat SortOrder within their list.
type ListItem struct {
	ID        string     `json:"id"`
	ListID    string     `json:"listId"`
	Kind      string     `json:"kind"` // 'task' | 'heading'
	TaskID    *string    `json:"taskId,omitempty"`
	Title     string     `json:"title"` // heading text; empty for task items
	SortOrder int        `json:"sortOrder"`
	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt time.Time  `json:"updatedAt"`
	DeletedAt *time.Time `json:"deletedAt,omitempty"`
	Version   int64      `json:"version"`
	Dirty     bool       `json:"dirty"`
}

// ErrInvalidListItem is returned when a list item fails validation.
var ErrInvalidListItem = errors.New("invalid list item")

// Validate checks the invariants that must hold before a list item is persisted.
func (i *ListItem) Validate() error {
	if strings.TrimSpace(i.ID) == "" {
		return errors.Join(ErrInvalidListItem, errors.New("id is required"))
	}
	if strings.TrimSpace(i.ListID) == "" {
		return errors.Join(ErrInvalidListItem, errors.New("listId is required"))
	}
	switch i.Kind {
	case ListItemTask:
		if i.TaskID == nil || strings.TrimSpace(*i.TaskID) == "" {
			return errors.Join(ErrInvalidListItem, errors.New("taskId is required for task items"))
		}
	case ListItemHeading:
		if i.TaskID != nil {
			return errors.Join(ErrInvalidListItem, errors.New("headings cannot reference a task"))
		}
	default:
		return errors.Join(ErrInvalidListItem, errors.New("kind must be task or heading"))
	}
	return nil
}

// SyncEntity implementation (PLAN §7).
func (i *ListItem) SyncID() string           { return i.ID }
func (i *ListItem) SyncVersion() int64       { return i.Version }
func (i *ListItem) SyncUpdatedAt() time.Time { return i.UpdatedAt }
func (i *ListItem) SyncDeleted() bool        { return i.DeletedAt != nil }
func (i *ListItem) SyncDirty() bool          { return i.Dirty }
