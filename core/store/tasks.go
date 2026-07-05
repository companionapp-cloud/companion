package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"companion/core/domain"
	"companion/core/sync/protocol"

	"github.com/google/uuid"
)

// TasksRepo is the CRUD + sync repository for tasks (PLAN §6.4). A task is a graph node:
// its NotesMD is scanned for wikilinks on every write and sync-apply, exactly like a
// note's body, so tasks join the graph for free (PLAN §5.1). Trash semantics mirror notes
// (PLAN §4.3).
type TasksRepo struct {
	db    Driver
	clock domain.Clock
	links *LinksRepo
}

const taskColumns = `id, title, notes_md, status, due_at, remind_at, completed_at, repeat_rule, repeat_seed_id, created_at, updated_at, deleting_at, deleted_at, version, dirty`

// CreateTaskInput carries the client-supplied fields for a new task.
type CreateTaskInput struct {
	Title    string     `json:"title"`
	NotesMD  string     `json:"notesMd"`
	Status   string     `json:"status"` // defaults to open when empty
	DueAt    *time.Time `json:"dueAt,omitempty"`
	RemindAt *time.Time `json:"remindAt,omitempty"`
}

// UpdateTaskInput carries partial updates; nil fields are unchanged. The nullable dueAt /
// remindAt need an explicit Clear flag because JSON can't distinguish "absent" from "set
// to null" on a pointer.
type UpdateTaskInput struct {
	Title         *string    `json:"title,omitempty"`
	NotesMD       *string    `json:"notesMd,omitempty"`
	Status        *string    `json:"status,omitempty"`
	DueAt         *time.Time `json:"dueAt,omitempty"`
	ClearDueAt    bool       `json:"clearDueAt,omitempty"`
	RemindAt      *time.Time `json:"remindAt,omitempty"`
	ClearRemindAt bool       `json:"clearRemindAt,omitempty"`
}

// Create inserts a new task (client UUIDv7, version 0, dirty), defaulting status to open,
// and indexes its notes as graph edges.
func (r *TasksRepo) Create(in CreateTaskInput) (*domain.Task, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return nil, fmt.Errorf("generate uuid: %w", err)
	}
	now := r.clock.Now().UTC()
	status := in.Status
	if status == "" {
		status = domain.TaskOpen
	}
	t := &domain.Task{
		ID: id.String(), Title: in.Title, NotesMD: in.NotesMD, Status: status,
		DueAt: in.DueAt, RemindAt: in.RemindAt,
		CreatedAt: now, UpdatedAt: now, Version: 0, Dirty: true,
	}
	if err := t.Validate(); err != nil {
		return nil, err
	}
	if _, err := r.db.Exec(
		`INSERT INTO tasks (id, title, notes_md, status, due_at, remind_at, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
		t.ID, t.Title, t.NotesMD, t.Status, nullTime(t.DueAt), nullTime(t.RemindAt),
		t.CreatedAt.Format(timeFormat), t.UpdatedAt.Format(timeFormat), t.Version, boolToInt(t.Dirty),
	); err != nil {
		return nil, fmt.Errorf("insert task: %w", err)
	}
	if err := r.links.SyncSource(domain.NodeTask, t.ID, t.NotesMD); err != nil {
		return nil, err
	}
	return t, nil
}

// Get returns a single live task by id (not deleted, not trashed), or ErrNotFound.
func (r *TasksRepo) Get(id string) (*domain.Task, error) {
	rows, err := r.db.Query(
		`SELECT `+taskColumns+` FROM tasks WHERE id = ? AND deleted_at IS NULL AND deleting_at IS NULL;`, id)
	if err != nil {
		return nil, fmt.Errorf("query task: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanTask(rows)
}

// List returns all live tasks, open first then by due date, newest-updated last as a
// tiebreak. Trashed and tombstoned tasks are excluded.
func (r *TasksRepo) List() ([]*domain.Task, error) {
	rows, err := r.db.Query(
		`SELECT ` + taskColumns + ` FROM tasks
		 WHERE deleted_at IS NULL AND deleting_at IS NULL
		 ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,
		          due_at IS NULL, due_at, updated_at DESC, id DESC;`)
	if err != nil {
		return nil, fmt.Errorf("query tasks: %w", err)
	}
	defer rows.Close()
	out := []*domain.Task{}
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// Update applies partial changes, maintains completed_at when status crosses done, bumps
// updated_at, marks dirty, and re-indexes links. Returns ErrNotFound if missing/trashed.
func (r *TasksRepo) Update(id string, in UpdateTaskInput) (*domain.Task, error) {
	t, err := r.Get(id)
	if err != nil {
		return nil, err
	}
	if in.Title != nil {
		t.Title = *in.Title
	}
	if in.NotesMD != nil {
		t.NotesMD = *in.NotesMD
	}
	if in.Status != nil && *in.Status != t.Status {
		t.Status = *in.Status
		if t.Status == domain.TaskDone {
			now := r.clock.Now().UTC()
			t.CompletedAt = &now
		} else {
			t.CompletedAt = nil
		}
	}
	if in.DueAt != nil {
		t.DueAt = in.DueAt
	} else if in.ClearDueAt {
		t.DueAt = nil
	}
	if in.RemindAt != nil {
		t.RemindAt = in.RemindAt
	} else if in.ClearRemindAt {
		t.RemindAt = nil
	}
	t.UpdatedAt = r.clock.Now().UTC()
	t.Dirty = true
	if err := t.Validate(); err != nil {
		return nil, err
	}
	res, err := r.db.Exec(
		`UPDATE tasks SET title = ?, notes_md = ?, status = ?, due_at = ?, remind_at = ?,
		   completed_at = ?, updated_at = ?, dirty = 1
		 WHERE id = ? AND deleted_at IS NULL AND deleting_at IS NULL;`,
		t.Title, t.NotesMD, t.Status, nullTime(t.DueAt), nullTime(t.RemindAt),
		nullTime(t.CompletedAt), t.UpdatedAt.Format(timeFormat), id,
	)
	if err != nil {
		return nil, fmt.Errorf("update task: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return nil, ErrNotFound
	}
	if err := r.links.SyncSource(domain.NodeTask, t.ID, t.NotesMD); err != nil {
		return nil, err
	}
	return t, nil
}

// Delete tombstones a task (the terminal "delete forever" primitive; everyday deletion
// goes through Trash). Dropping its outgoing edges. Returns ErrNotFound if already gone.
func (r *TasksRepo) Delete(id string) error {
	now := r.clock.Now().UTC()
	res, err := r.db.Exec(
		`UPDATE tasks SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ? AND deleted_at IS NULL;`,
		now.Format(timeFormat), now.Format(timeFormat), id,
	)
	if err != nil {
		return fmt.Errorf("delete task: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	return r.links.DeleteSource(domain.NodeTask, id)
}

// Trash moves a task to the Trash (PLAN §4.3): sets deleting_at = now + TrashRetention and
// drops it from the graph. Restore re-derives its edges. ErrNotFound if missing/already
// trashed/tombstoned.
func (r *TasksRepo) Trash(id string) error {
	now := r.clock.Now().UTC()
	deletingAt := now.Add(TrashRetention)
	res, err := r.db.Exec(
		`UPDATE tasks SET deleting_at = ?, updated_at = ?, dirty = 1
		 WHERE id = ? AND deleted_at IS NULL AND deleting_at IS NULL;`,
		deletingAt.Format(timeFormat), now.Format(timeFormat), id,
	)
	if err != nil {
		return fmt.Errorf("trash task: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	return r.links.DeleteSource(domain.NodeTask, id)
}

// Restore brings a task back from the Trash (or a tombstone) and re-indexes its links.
func (r *TasksRepo) Restore(id string) error {
	t, err := r.GetAny(id)
	if err != nil {
		return err
	}
	if t.DeletedAt == nil && t.DeletingAt == nil {
		return ErrNotFound
	}
	now := r.clock.Now().UTC()
	res, err := r.db.Exec(
		`UPDATE tasks SET deleting_at = NULL, deleted_at = NULL, updated_at = ?, dirty = 1
		 WHERE id = ? AND (deleted_at IS NOT NULL OR deleting_at IS NOT NULL);`,
		now.Format(timeFormat), id,
	)
	if err != nil {
		return fmt.Errorf("restore task: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	return r.links.SyncSource(domain.NodeTask, t.ID, t.NotesMD)
}

// ListTrash returns every trashed task, soonest-to-be-purged first (PLAN §4.3).
func (r *TasksRepo) ListTrash() ([]*domain.Task, error) {
	rows, err := r.db.Query(
		`SELECT ` + taskColumns + ` FROM tasks WHERE deleted_at IS NULL AND deleting_at IS NOT NULL ORDER BY deleting_at ASC, id ASC;`)
	if err != nil {
		return nil, fmt.Errorf("query trashed tasks: %w", err)
	}
	defer rows.Close()
	out := []*domain.Task{}
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// --- SyncableRepo[*domain.Task] (PLAN §7) ---------------------------------

func (r *TasksRepo) EntityType() string { return protocol.EntityTask }

func (r *TasksRepo) Dirty() ([]*domain.Task, error) {
	rows, err := r.db.Query(`SELECT ` + taskColumns + ` FROM tasks WHERE dirty = 1 ORDER BY updated_at ASC, id ASC;`)
	if err != nil {
		return nil, fmt.Errorf("query dirty tasks: %w", err)
	}
	defer rows.Close()
	out := []*domain.Task{}
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (r *TasksRepo) GetAny(id string) (*domain.Task, error) {
	rows, err := r.db.Query(`SELECT `+taskColumns+` FROM tasks WHERE id = ?;`, id)
	if err != nil {
		return nil, fmt.Errorf("query task: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanTask(rows)
}

func (r *TasksRepo) Apply(t *domain.Task) error {
	_, err := r.db.Exec(
		`INSERT INTO tasks (id, title, notes_md, status, due_at, remind_at, completed_at, repeat_rule, repeat_seed_id, created_at, updated_at, deleting_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   title = excluded.title, notes_md = excluded.notes_md, status = excluded.status,
		   due_at = excluded.due_at, remind_at = excluded.remind_at, completed_at = excluded.completed_at,
		   repeat_rule = excluded.repeat_rule, repeat_seed_id = excluded.repeat_seed_id,
		   created_at = excluded.created_at, updated_at = excluded.updated_at,
		   deleting_at = excluded.deleting_at, deleted_at = excluded.deleted_at,
		   version = excluded.version, dirty = 0;`,
		t.ID, t.Title, t.NotesMD, t.Status, nullTime(t.DueAt), nullTime(t.RemindAt), nullTime(t.CompletedAt),
		t.RepeatRule, t.RepeatSeedID,
		t.CreatedAt.UTC().Format(timeFormat), t.UpdatedAt.UTC().Format(timeFormat),
		nullTime(t.DeletingAt), nullTime(t.DeletedAt), t.Version,
	)
	if err != nil {
		return fmt.Errorf("apply task: %w", err)
	}
	// A tombstone or a trashed task drops its edges; otherwise re-derive from notes.
	if t.DeletedAt != nil || t.DeletingAt != nil {
		return r.links.DeleteSource(domain.NodeTask, t.ID)
	}
	return r.links.SyncSource(domain.NodeTask, t.ID, t.NotesMD)
}

func (r *TasksRepo) MarkPushed(id string, version int64) error {
	if _, err := r.db.Exec(`UPDATE tasks SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark pushed: %w", err)
	}
	return nil
}

func (r *TasksRepo) MeaningfulDiff(a, b *domain.Task) bool {
	if a.Title != b.Title || a.NotesMD != b.NotesMD || a.Status != b.Status {
		return true
	}
	if !sameTime(a.DueAt, b.DueAt) || !sameTime(a.RemindAt, b.RemindAt) {
		return true
	}
	if (a.DeletingAt == nil) != (b.DeletingAt == nil) {
		return true
	}
	return (a.DeletedAt == nil) != (b.DeletedAt == nil)
}

func (r *TasksRepo) Decode(raw json.RawMessage) (*domain.Task, error) {
	var t domain.Task
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, fmt.Errorf("decode task: %w", err)
	}
	return &t, nil
}

// ConflictedCopy forks a losing local task into a fresh row (§7.3).
func (r *TasksRepo) ConflictedCopy(local *domain.Task, suffix string) error {
	id, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("generate uuid: %w", err)
	}
	now := r.clock.Now().UTC()
	title := local.Title
	if title == "" {
		title = "Untitled"
	}
	if _, err := r.db.Exec(
		`INSERT INTO tasks (id, title, notes_md, status, due_at, remind_at, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1);`,
		id.String(), title+" "+suffix, local.NotesMD, local.Status, nullTime(local.DueAt), nullTime(local.RemindAt),
		now.Format(timeFormat), now.Format(timeFormat),
	); err != nil {
		return fmt.Errorf("insert conflicted task: %w", err)
	}
	return r.links.SyncSource(domain.NodeTask, id.String(), local.NotesMD)
}

// nullTime formats a nullable timestamp for binding, or nil for a NULL column.
func nullTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UTC().Format(timeFormat)
}

// sameTime reports whether two nullable timestamps are equal (both nil, or same instant).
func sameTime(a, b *time.Time) bool {
	if (a == nil) != (b == nil) {
		return false
	}
	return a == nil || a.Equal(*b)
}

func scanTask(rows Rows) (*domain.Task, error) {
	var (
		t                                                   domain.Task
		notesMD                                             sql.NullString
		dueAt, remindAt, completedAt, deletingAt, deletedAt sql.NullString
		repeatRule, repeatSeedID                            sql.NullString
		createdAt, updatedAt                                string
		dirty                                               int
	)
	if err := rows.Scan(
		&t.ID, &t.Title, &notesMD, &t.Status, &dueAt, &remindAt, &completedAt,
		&repeatRule, &repeatSeedID, &createdAt, &updatedAt, &deletingAt, &deletedAt, &t.Version, &dirty,
	); err != nil {
		return nil, fmt.Errorf("scan task: %w", err)
	}
	t.NotesMD = notesMD.String
	var err error
	if t.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if t.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	if t.DueAt, err = parseNullTime(dueAt); err != nil {
		return nil, err
	}
	if t.RemindAt, err = parseNullTime(remindAt); err != nil {
		return nil, err
	}
	if t.CompletedAt, err = parseNullTime(completedAt); err != nil {
		return nil, err
	}
	if t.DeletingAt, err = parseNullTime(deletingAt); err != nil {
		return nil, err
	}
	if t.DeletedAt, err = parseNullTime(deletedAt); err != nil {
		return nil, err
	}
	if repeatRule.Valid {
		t.RepeatRule = &repeatRule.String
	}
	if repeatSeedID.Valid {
		t.RepeatSeedID = &repeatSeedID.String
	}
	t.Dirty = dirty != 0
	return &t, nil
}

// parseNullTime parses a nullable RFC3339 column into a *time.Time.
func parseNullTime(s sql.NullString) (*time.Time, error) {
	if !s.Valid {
		return nil, nil
	}
	parsed, err := time.Parse(timeFormat, s.String)
	if err != nil {
		return nil, fmt.Errorf("parse time %q: %w", s.String, err)
	}
	return &parsed, nil
}
