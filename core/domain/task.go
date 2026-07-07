package domain

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Task status values (PLAN §4.1). A task's "kind" is not a subtype but a shape over these
// columns: a one-off has neither DueAt nor RepeatRule; a scheduled task has DueAt; a
// reminder has RemindAt (PLAN §6.4).
const (
	TaskOpen      = "open"
	TaskDone      = "done"
	TaskCancelled = "cancelled"
)

// Task is a to-do item and a first-class graph node: its NotesMD is scanned for wikilinks
// the same way a note's body is (PLAN §6.4, §5.1). RepeatRule / RepeatSeedID are carried
// for the repeating-tasks milestone but unused until then; they still sync.
type Task struct {
	ID           string     `json:"id"`
	Title        string     `json:"title"`
	NotesMD      string     `json:"notesMd"`
	Status       string     `json:"status"` // open | done | cancelled
	DueAt        *time.Time `json:"dueAt,omitempty"`
	RemindAt     *time.Time `json:"remindAt,omitempty"`
	CompletedAt  *time.Time `json:"completedAt,omitempty"`
	RepeatRule   *string    `json:"repeatRule,omitempty"`
	RepeatSeedID *string    `json:"repeatSeedId,omitempty"`
	// ObjectTypeID / Props archetype the task (PLAN §6.3), exactly as on notes.
	ObjectTypeID *string         `json:"objectTypeId,omitempty"`
	Props        json.RawMessage `json:"props,omitempty"`
	CreatedAt    time.Time       `json:"createdAt"`
	UpdatedAt    time.Time       `json:"updatedAt"`
	// DeletingAt is the Trash marker (PLAN §4.3), like notes: a trashed task is hidden
	// from every query but the Trash and still syncs until the server purges it.
	DeletingAt *time.Time `json:"deletingAt,omitempty"`
	DeletedAt  *time.Time `json:"deletedAt,omitempty"`
	Version    int64      `json:"version"`
	Dirty      bool       `json:"dirty"`
}

// ErrInvalidTask is returned when a task fails validation.
var ErrInvalidTask = errors.New("invalid task")

// validTaskStatus reports whether s is a known status.
func validTaskStatus(s string) bool {
	return s == TaskOpen || s == TaskDone || s == TaskCancelled
}

// Validate checks the invariants that must hold before a task is persisted.
func (t *Task) Validate() error {
	if strings.TrimSpace(t.ID) == "" {
		return errors.Join(ErrInvalidTask, errors.New("id is required"))
	}
	if !validTaskStatus(t.Status) {
		return errors.Join(ErrInvalidTask, errors.New("status must be open, done, or cancelled"))
	}
	return nil
}

// SyncEntity implementation (PLAN §7). A trashed task (DeletingAt set) is not a tombstone;
// it keeps syncing until the server's collector purges it (PLAN §7.6).
func (t *Task) SyncID() string           { return t.ID }
func (t *Task) SyncVersion() int64       { return t.Version }
func (t *Task) SyncUpdatedAt() time.Time { return t.UpdatedAt }
func (t *Task) SyncDeleted() bool        { return t.DeletedAt != nil }
func (t *Task) SyncDirty() bool          { return t.Dirty }
