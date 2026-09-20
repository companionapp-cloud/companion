package domain

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"
)

// Task status values (PLAN §4.1). A task's "kind" is not a subtype but a shape over these
// columns: a one-off has no dates and no RepeatRule; a scheduled task has a StartAt and/or a
// deadline (DueAt); a reminder has Reminders (PLAN §6.4).
const (
	TaskOpen      = "open"
	TaskDone      = "done"
	TaskCancelled = "cancelled"
)

// Task is a to-do item and a first-class graph node: its NotesMD is scanned for wikilinks
// the same way a note's body is (PLAN §6.4, §5.1). A repeating task is a seed (RepeatRule set)
// whose occurrences the server materializes (RepeatSeedID points back at the seed).
type Task struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	NotesMD string `json:"notesMd"`
	Status  string `json:"status"` // open | done | cancelled
	// StartAt is when the task starts: the moment it becomes something to work on.
	StartAt *time.Time `json:"startAt,omitempty"`
	// Someday stands in for a start: the task is filed away under the Someday filter and out
	// of every other list (PLAN-scheduling.md §1). It never coexists with a StartAt.
	Someday bool `json:"someday"`
	// DueAt is the task's deadline. The field keeps its original "due" name (column, wire and
	// TS) but is presented as "Deadline". It places the task on the calendar, anchors relative
	// reminders, and anchors a repeat's schedule.
	DueAt *time.Time `json:"dueAt,omitempty"`
	// Reminders are the task's notifications (see Reminder), normalized on write. Always a
	// list, never omitted: an empty list means "no reminders", so a full-row sync push can
	// clear them.
	Reminders    []Reminder `json:"reminders"`
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
	if t.Someday && t.StartAt != nil {
		return errors.Join(ErrInvalidTask, errors.New("a someday task has no start"))
	}
	if err := ValidateRepeatRule(t.RepeatRule); err != nil {
		return errors.Join(ErrInvalidTask, err)
	}
	if err := ValidateReminders(t.Reminders); err != nil {
		return errors.Join(ErrInvalidTask, err)
	}
	return nil
}

// ReminderFires resolves the task's reminders against its current deadline: the instants
// they fire at, sorted and de-duplicated. Relative reminders drop out while the task has no
// deadline.
func (t *Task) ReminderFires() []time.Time {
	out := make([]time.Time, 0, len(t.Reminders))
	seen := map[int64]bool{}
	for _, r := range t.Reminders {
		at := r.FireAt(t.DueAt)
		if at == nil || seen[at.UnixNano()] {
			continue
		}
		seen[at.UnixNano()] = true
		out = append(out, *at)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Before(out[j]) })
	return out
}

// IsRepeatSeed reports whether this task is a repeating-task definition: it carries an
// RRULE but is not itself a materialized occurrence (PLAN §6.4). Seeds are hidden from the
// actionable task list; their occurrences are the real to-dos.
func (t *Task) IsRepeatSeed() bool {
	return t.RepeatRule != nil && strings.TrimSpace(*t.RepeatRule) != "" && t.RepeatSeedID == nil
}

// SyncEntity implementation (PLAN §7). A trashed task (DeletingAt set) is not a tombstone;
// it keeps syncing until the server's collector purges it (PLAN §7.6).
func (t *Task) SyncID() string           { return t.ID }
func (t *Task) SyncVersion() int64       { return t.Version }
func (t *Task) SyncUpdatedAt() time.Time { return t.UpdatedAt }
func (t *Task) SyncDeleted() bool        { return t.DeletedAt != nil }
func (t *Task) SyncDirty() bool          { return t.Dirty }
