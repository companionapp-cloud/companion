package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"companion/core/domain"
	"companion/core/sync/protocol"
)

// NotificationReadsRepo persists which in-app notifications the user has read (PLAN §6.4).
// The feed is derived live from tasks (notify.FeedTasks); a row here marks one fire read.
// Rows use a deterministic id (domain.NotificationReadID) so devices converge on one row
// per fire, and they sync like any other entity.
type NotificationReadsRepo struct {
	db    Driver
	clock domain.Clock
}

const notificationReadColumns = `id, task_id, fire_at, read_at, created_at, updated_at, deleted_at, version, dirty`

// MarkRead records one fire as read. Idempotent: a live row for the fire is left as-is
// (re-reading doesn't dirty it), and a tombstoned row is revived.
func (r *NotificationReadsRepo) MarkRead(taskID string, fireAt time.Time) (*domain.NotificationRead, error) {
	now := r.clock.Now().UTC()
	n := &domain.NotificationRead{
		ID: domain.NotificationReadID(taskID, fireAt), TaskID: taskID, FireAt: fireAt.UTC(),
		ReadAt: now, CreatedAt: now, UpdatedAt: now, Version: 0, Dirty: true,
	}
	if err := n.Validate(); err != nil {
		return nil, err
	}
	existing, err := r.GetAny(n.ID)
	if err == nil && existing.DeletedAt == nil {
		return existing, nil
	}
	if err != nil && !errors.Is(err, ErrNotFound) {
		return nil, err
	}
	if existing != nil {
		// Revive the tombstone in place, keeping its version so the push is an update.
		n.CreatedAt = existing.CreatedAt
		n.Version = existing.Version
	}
	if _, err := r.db.Exec(
		`INSERT INTO notification_reads (id, task_id, fire_at, read_at, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 1)
		 ON CONFLICT(id) DO UPDATE SET
		   read_at = excluded.read_at, updated_at = excluded.updated_at, deleted_at = NULL, dirty = 1;`,
		n.ID, n.TaskID, n.FireAt.Format(timeFormat), n.ReadAt.Format(timeFormat),
		n.CreatedAt.Format(timeFormat), n.UpdatedAt.Format(timeFormat), n.Version,
	); err != nil {
		return nil, fmt.Errorf("insert notification read: %w", err)
	}
	return n, nil
}

// ReadIDs returns the ids of live read rows whose fire lies at or after `since` — the set
// the bridge joins against the derived feed (older rows have aged out of the feed anyway).
func (r *NotificationReadsRepo) ReadIDs(since time.Time) (map[string]bool, error) {
	rows, err := r.db.Query(
		`SELECT id FROM notification_reads WHERE deleted_at IS NULL AND fire_at >= ?;`,
		since.UTC().Format(timeFormat),
	)
	if err != nil {
		return nil, fmt.Errorf("query notification reads: %w", err)
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan notification read id: %w", err)
		}
		out[id] = true
	}
	return out, rows.Err()
}

// --- SyncableRepo[*domain.NotificationRead] --------------------------------

func (r *NotificationReadsRepo) EntityType() string { return protocol.EntityNotificationRead }

func (r *NotificationReadsRepo) Dirty() ([]*domain.NotificationRead, error) {
	rows, err := r.db.Query(`SELECT ` + notificationReadColumns + ` FROM notification_reads WHERE dirty = 1 ORDER BY updated_at ASC, id ASC;`)
	if err != nil {
		return nil, fmt.Errorf("query dirty notification reads: %w", err)
	}
	defer rows.Close()
	out := []*domain.NotificationRead{}
	for rows.Next() {
		n, err := scanNotificationRead(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

func (r *NotificationReadsRepo) GetAny(id string) (*domain.NotificationRead, error) {
	rows, err := r.db.Query(`SELECT `+notificationReadColumns+` FROM notification_reads WHERE id = ?;`, id)
	if err != nil {
		return nil, fmt.Errorf("query notification read: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanNotificationRead(rows)
}

func (r *NotificationReadsRepo) Apply(n *domain.NotificationRead) error {
	var deletedAt any
	if n.DeletedAt != nil {
		deletedAt = n.DeletedAt.UTC().Format(timeFormat)
	}
	_, err := r.db.Exec(
		`INSERT INTO notification_reads (id, task_id, fire_at, read_at, created_at, updated_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   task_id = excluded.task_id, fire_at = excluded.fire_at, read_at = excluded.read_at,
		   created_at = excluded.created_at, updated_at = excluded.updated_at,
		   deleted_at = excluded.deleted_at, version = excluded.version, dirty = 0;`,
		n.ID, n.TaskID, n.FireAt.UTC().Format(timeFormat), n.ReadAt.UTC().Format(timeFormat),
		n.CreatedAt.UTC().Format(timeFormat), n.UpdatedAt.UTC().Format(timeFormat), deletedAt, n.Version,
	)
	if err != nil {
		return fmt.Errorf("apply notification read: %w", err)
	}
	return nil
}

func (r *NotificationReadsRepo) MarkPushed(id string, version int64) error {
	if _, err := r.db.Exec(`UPDATE notification_reads SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark pushed: %w", err)
	}
	return nil
}

// MeaningfulDiff: a read receipt carries no user content — both sides saying "read" agree
// regardless of timestamps, so only alive-vs-deleted differs meaningfully.
func (r *NotificationReadsRepo) MeaningfulDiff(a, b *domain.NotificationRead) bool {
	return (a.DeletedAt == nil) != (b.DeletedAt == nil)
}

func (r *NotificationReadsRepo) Decode(raw json.RawMessage) (*domain.NotificationRead, error) {
	var n domain.NotificationRead
	if err := json.Unmarshal(raw, &n); err != nil {
		return nil, fmt.Errorf("decode notification read: %w", err)
	}
	return &n, nil
}

// ConflictedCopy is a no-op: two devices marking the same fire read are already in
// agreement; there is nothing to preserve (server wins).
func (r *NotificationReadsRepo) ConflictedCopy(_ *domain.NotificationRead, _ string) error { return nil }

func scanNotificationRead(rows Rows) (*domain.NotificationRead, error) {
	var (
		n                                    domain.NotificationRead
		fireAt, readAt, createdAt, updatedAt string
		deletedAt                            sql.NullString
		dirty                                int
	)
	if err := rows.Scan(&n.ID, &n.TaskID, &fireAt, &readAt, &createdAt, &updatedAt, &deletedAt, &n.Version, &dirty); err != nil {
		return nil, fmt.Errorf("scan notification read: %w", err)
	}
	var err error
	if n.FireAt, err = time.Parse(timeFormat, fireAt); err != nil {
		return nil, fmt.Errorf("parse fire_at: %w", err)
	}
	if n.ReadAt, err = time.Parse(timeFormat, readAt); err != nil {
		return nil, fmt.Errorf("parse read_at: %w", err)
	}
	if n.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if n.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	if deletedAt.Valid {
		t, err := time.Parse(timeFormat, deletedAt.String)
		if err != nil {
			return nil, fmt.Errorf("parse deleted_at: %w", err)
		}
		n.DeletedAt = &t
	}
	n.Dirty = dirty != 0
	return &n, nil
}
