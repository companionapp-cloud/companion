package domain

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// NotificationRead records that the user read one in-app notification — one fire of one
// task's reminder/due (PLAN §6.4). The feed itself is derived live from tasks
// (notify.FeedTasks); only the read flag needs persisting, and it syncs so a notification
// read on one device is read everywhere. Row existence *is* the read state: there is no
// unread row, and rows tombstone (DeletedAt) only if their task disappears entirely.
type NotificationRead struct {
	ID        string     `json:"id"` // deterministic: <taskId>:<fireAt unix-ms> (NotificationReadID)
	TaskID    string     `json:"taskId"`
	FireAt    time.Time  `json:"fireAt"`
	ReadAt    time.Time  `json:"readAt"`
	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt time.Time  `json:"updatedAt"`
	DeletedAt *time.Time `json:"deletedAt,omitempty"`
	Version   int64      `json:"version"`
	Dirty     bool       `json:"dirty"`
}

// NotificationReadID is the deterministic row id for a fire. Two devices marking the same
// notification read must converge on one row, so the id is derived from the fire identity
// rather than generated — the sync upsert then collapses them.
func NotificationReadID(taskID string, fireAt time.Time) string {
	return fmt.Sprintf("%s:%d", taskID, fireAt.UTC().UnixMilli())
}

// ErrInvalidNotificationRead is returned when a notification read fails validation.
var ErrInvalidNotificationRead = errors.New("invalid notification read")

// Validate checks the invariants that must hold before a row is persisted.
func (n *NotificationRead) Validate() error {
	if strings.TrimSpace(n.ID) == "" {
		return errors.Join(ErrInvalidNotificationRead, errors.New("id is required"))
	}
	if strings.TrimSpace(n.TaskID) == "" {
		return errors.Join(ErrInvalidNotificationRead, errors.New("taskId is required"))
	}
	if n.FireAt.IsZero() {
		return errors.Join(ErrInvalidNotificationRead, errors.New("fireAt is required"))
	}
	return nil
}

// SyncEntity implementation (PLAN §7).
func (n *NotificationRead) SyncID() string           { return n.ID }
func (n *NotificationRead) SyncVersion() int64       { return n.Version }
func (n *NotificationRead) SyncUpdatedAt() time.Time { return n.UpdatedAt }
func (n *NotificationRead) SyncDeleted() bool        { return n.DeletedAt != nil }
func (n *NotificationRead) SyncDirty() bool          { return n.Dirty }
