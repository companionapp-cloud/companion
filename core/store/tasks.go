package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
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
	db          Driver
	clock       domain.Clock
	links       *LinksRepo
	objectTypes *ObjectTypesRepo
}

const taskColumns = `id, title, notes_md, status, start_at, due_at, reminders_json, completed_at, repeat_rule, repeat_seed_id, object_type_id, props_json, created_at, updated_at, deleting_at, deleted_at, version, dirty`

// CreateTaskInput carries the client-supplied fields for a new task. ObjectTypeID/Props
// archetype the task (PLAN §6.3).
type CreateTaskInput struct {
	Title   string     `json:"title"`
	NotesMD string     `json:"notesMd"`
	Status  string     `json:"status"` // defaults to open when empty
	StartAt *time.Time `json:"startAt,omitempty"`
	// DueAt is the deadline (PLAN §6.4).
	DueAt     *time.Time        `json:"dueAt,omitempty"`
	Reminders []domain.Reminder `json:"reminders,omitempty"`
	// RepeatRule turns this into a repeating-task seed (RFC5545 RRULE); the server
	// materializes its occurrences (PLAN §6.4). Occurrences are never created on the client.
	RepeatRule   *string         `json:"repeatRule,omitempty"`
	ObjectTypeID *string         `json:"objectTypeId,omitempty"`
	Props        json.RawMessage `json:"props,omitempty"`
	// CompletedAt dates a task created already done (an import keeps when it was finished);
	// a done task created without one is completed now. Ignored unless Status is done.
	CompletedAt *time.Time `json:"completedAt,omitempty"`
}

// UpdateTaskInput carries partial updates; nil fields are unchanged. The nullable startAt /
// dueAt need an explicit Clear flag because JSON can't distinguish "absent" from "set to
// null" on a pointer; likewise ClearObjectType for the archetype. Reminders replaces the
// whole list when present — an empty list clears it.
type UpdateTaskInput struct {
	Title           *string            `json:"title,omitempty"`
	NotesMD         *string            `json:"notesMd,omitempty"`
	Status          *string            `json:"status,omitempty"`
	StartAt         *time.Time         `json:"startAt,omitempty"`
	ClearStartAt    bool               `json:"clearStartAt,omitempty"`
	DueAt           *time.Time         `json:"dueAt,omitempty"`
	ClearDueAt      bool               `json:"clearDueAt,omitempty"`
	Reminders       *[]domain.Reminder `json:"reminders,omitempty"`
	RepeatRule      *string            `json:"repeatRule,omitempty"`
	ClearRepeatRule bool             `json:"clearRepeatRule,omitempty"`
	ObjectTypeID    *string          `json:"objectTypeId,omitempty"`
	ClearObjectType bool             `json:"clearObjectType,omitempty"`
	Props           *json.RawMessage `json:"props,omitempty"`
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
	reminders, err := domain.NormalizeReminders(in.Reminders)
	if err != nil {
		return nil, errors.Join(domain.ErrInvalidTask, err)
	}
	t := &domain.Task{
		ID: id.String(), Title: in.Title, NotesMD: in.NotesMD, Status: status,
		StartAt: in.StartAt, DueAt: in.DueAt, Reminders: reminders, RepeatRule: trimmedRule(in.RepeatRule),
		ObjectTypeID: in.ObjectTypeID, Props: json.RawMessage(normalizeProps(in.Props)),
		CreatedAt: now, UpdatedAt: now, Version: 0, Dirty: true,
	}
	if status == domain.TaskDone {
		completed := now
		if in.CompletedAt != nil {
			completed = in.CompletedAt.UTC()
		}
		t.CompletedAt = &completed
	}
	if err := t.Validate(); err != nil {
		return nil, err
	}
	if err := r.objectTypes.ValidateEntityProps(t.ObjectTypeID, t.Props); err != nil {
		return nil, err
	}
	if _, err := r.db.Exec(
		`INSERT INTO tasks (id, title, notes_md, status, start_at, due_at, reminders_json, completed_at, repeat_rule, object_type_id, props_json, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
		t.ID, t.Title, t.NotesMD, t.Status, nullTime(t.StartAt), nullTime(t.DueAt), remindersJSON(t.Reminders), nullTime(t.CompletedAt), t.RepeatRule, t.ObjectTypeID, string(t.Props),
		t.CreatedAt.Format(timeFormat), t.UpdatedAt.Format(timeFormat), t.Version, boolToInt(t.Dirty),
	); err != nil {
		return nil, fmt.Errorf("insert task: %w", err)
	}
	if err := r.links.SyncEntitySource(domain.NodeTask, t.ID, t.NotesMD, t.ObjectTypeID, string(t.Props)); err != nil {
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

// List returns all live actionable tasks, open first then by due date, newest-updated last
// as a tiebreak. Trashed and tombstoned tasks are excluded — and so are repeating-task
// **seeds** (repeat_rule set, repeat_seed_id NULL): a seed is a definition, not a to-do; its
// materialized occurrences are the actionable rows that appear here (PLAN §6.4). ListSeeds
// surfaces the definitions separately.
func (r *TasksRepo) List() ([]*domain.Task, error) {
	rows, err := r.db.Query(
		`SELECT ` + taskColumns + ` FROM tasks
		 WHERE deleted_at IS NULL AND deleting_at IS NULL
		   AND NOT (repeat_rule IS NOT NULL AND repeat_seed_id IS NULL)
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

// ListSeeds returns the live repeating-task definitions (seeds), newest first. The bridge
// pairs each with its computed next occurrence for the "Repeating" UI, which is also the
// only thing a client with no server configured can show (occurrences never materialize).
func (r *TasksRepo) ListSeeds() ([]*domain.Task, error) {
	rows, err := r.db.Query(
		`SELECT ` + taskColumns + ` FROM tasks
		 WHERE deleted_at IS NULL AND deleting_at IS NULL
		   AND repeat_rule IS NOT NULL AND repeat_seed_id IS NULL
		 ORDER BY created_at DESC, id DESC;`)
	if err != nil {
		return nil, fmt.Errorf("query task seeds: %w", err)
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
	if in.StartAt != nil {
		t.StartAt = in.StartAt
	} else if in.ClearStartAt {
		t.StartAt = nil
	}
	if in.DueAt != nil {
		t.DueAt = in.DueAt
	} else if in.ClearDueAt {
		t.DueAt = nil
	}
	if in.Reminders != nil {
		reminders, err := domain.NormalizeReminders(*in.Reminders)
		if err != nil {
			return nil, errors.Join(domain.ErrInvalidTask, err)
		}
		t.Reminders = reminders
	}
	if in.ClearRepeatRule {
		t.RepeatRule = nil
	} else if in.RepeatRule != nil {
		t.RepeatRule = trimmedRule(in.RepeatRule)
	}
	if in.ClearObjectType {
		t.ObjectTypeID = nil
	} else if in.ObjectTypeID != nil {
		t.ObjectTypeID = in.ObjectTypeID
	}
	if in.Props != nil {
		t.Props = json.RawMessage(normalizeProps(*in.Props))
	}
	t.UpdatedAt = r.clock.Now().UTC()
	t.Dirty = true
	if err := t.Validate(); err != nil {
		return nil, err
	}
	if err := r.objectTypes.ValidateEntityProps(t.ObjectTypeID, t.Props); err != nil {
		return nil, err
	}
	res, err := r.db.Exec(
		`UPDATE tasks SET title = ?, notes_md = ?, status = ?, start_at = ?, due_at = ?, reminders_json = ?,
		   completed_at = ?, repeat_rule = ?, object_type_id = ?, props_json = ?, updated_at = ?, dirty = 1
		 WHERE id = ? AND deleted_at IS NULL AND deleting_at IS NULL;`,
		t.Title, t.NotesMD, t.Status, nullTime(t.StartAt), nullTime(t.DueAt), remindersJSON(t.Reminders),
		nullTime(t.CompletedAt), t.RepeatRule, t.ObjectTypeID, string(normalizeProps(t.Props)), t.UpdatedAt.Format(timeFormat), id,
	)
	if err != nil {
		return nil, fmt.Errorf("update task: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return nil, ErrNotFound
	}
	if err := r.links.SyncEntitySource(domain.NodeTask, t.ID, t.NotesMD, t.ObjectTypeID, string(normalizeProps(t.Props))); err != nil {
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

// TrashMany moves several tasks to the Trash in one statement (bulk multiselect delete —
// PLAN §6.6), mirroring Trash: one UPDATE flips deleting_at/updated_at/dirty for every
// still-live id, then each task's edges are dropped. Missing/already-trashed/tombstoned ids
// are skipped. Returns the number of tasks actually trashed.
func (r *TasksRepo) TrashMany(ids []string) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	now := r.clock.Now().UTC()
	deletingAt := now.Add(TrashRetention)
	in, idArgs := placeholders(ids)
	args := append([]any{deletingAt.Format(timeFormat), now.Format(timeFormat)}, idArgs...)
	res, err := r.db.Exec(
		`UPDATE tasks SET deleting_at = ?, updated_at = ?, dirty = 1
		 WHERE id IN (`+in+`) AND deleted_at IS NULL AND deleting_at IS NULL;`,
		args...,
	)
	if err != nil {
		return 0, fmt.Errorf("trash tasks: %w", err)
	}
	affected, _ := res.RowsAffected()
	for _, id := range ids {
		if err := r.links.DeleteSource(domain.NodeTask, id); err != nil {
			return affected, err
		}
	}
	return affected, nil
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
	return r.links.SyncEntitySource(domain.NodeTask, t.ID, t.NotesMD, t.ObjectTypeID, string(normalizeProps(t.Props)))
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
		`INSERT INTO tasks (id, title, notes_md, status, start_at, due_at, reminders_json, completed_at, repeat_rule, repeat_seed_id, object_type_id, props_json, created_at, updated_at, deleting_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   title = excluded.title, notes_md = excluded.notes_md, status = excluded.status,
		   start_at = excluded.start_at, due_at = excluded.due_at, reminders_json = excluded.reminders_json,
		   completed_at = excluded.completed_at,
		   repeat_rule = excluded.repeat_rule, repeat_seed_id = excluded.repeat_seed_id,
		   object_type_id = excluded.object_type_id, props_json = excluded.props_json,
		   created_at = excluded.created_at, updated_at = excluded.updated_at,
		   deleting_at = excluded.deleting_at, deleted_at = excluded.deleted_at,
		   version = excluded.version, dirty = 0;`,
		t.ID, t.Title, t.NotesMD, t.Status, nullTime(t.StartAt), nullTime(t.DueAt), remindersJSON(t.Reminders), nullTime(t.CompletedAt),
		t.RepeatRule, t.RepeatSeedID, t.ObjectTypeID, normalizeProps(t.Props),
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
	return r.links.SyncEntitySource(domain.NodeTask, t.ID, t.NotesMD, t.ObjectTypeID, normalizeProps(t.Props))
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
	if !sameTime(a.StartAt, b.StartAt) || !sameTime(a.DueAt, b.DueAt) || remindersJSON(a.Reminders) != remindersJSON(b.Reminders) {
		return true
	}
	if derefStr(a.ObjectTypeID) != derefStr(b.ObjectTypeID) || normalizeProps(a.Props) != normalizeProps(b.Props) {
		return true
	}
	if derefStr(a.RepeatRule) != derefStr(b.RepeatRule) || derefStr(a.RepeatSeedID) != derefStr(b.RepeatSeedID) {
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
		`INSERT INTO tasks (id, title, notes_md, status, start_at, due_at, reminders_json, object_type_id, props_json, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1);`,
		id.String(), title+" "+suffix, local.NotesMD, local.Status, nullTime(local.StartAt), nullTime(local.DueAt), remindersJSON(local.Reminders),
		local.ObjectTypeID, normalizeProps(local.Props),
		now.Format(timeFormat), now.Format(timeFormat),
	); err != nil {
		return fmt.Errorf("insert conflicted task: %w", err)
	}
	return r.links.SyncEntitySource(domain.NodeTask, id.String(), local.NotesMD, local.ObjectTypeID, normalizeProps(local.Props))
}

// trimmedRule normalizes a repeat rule for storage: whitespace-only becomes NULL so a
// blank rule never masquerades as a repeating seed.
func trimmedRule(rule *string) *string {
	if rule == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*rule)
	if trimmed == "" {
		return nil
	}
	return &trimmed
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

// remindersJSON serializes a reminder list for the reminders_json column: always an array,
// "[]" for none.
func remindersJSON(rs []domain.Reminder) string {
	if len(rs) == 0 {
		return "[]"
	}
	b, err := json.Marshal(rs)
	if err != nil {
		return "[]"
	}
	return string(b)
}

// parseReminders reads the reminders_json column leniently: a malformed value (which only a
// buggy peer could have synced) reads as no reminders rather than failing every task query.
func parseReminders(s string) []domain.Reminder {
	out := []domain.Reminder{}
	if strings.TrimSpace(s) == "" || json.Unmarshal([]byte(s), &out) != nil || out == nil {
		return []domain.Reminder{}
	}
	return out
}

func scanTask(rows Rows) (*domain.Task, error) {
	var (
		t                                                  domain.Task
		notesMD, remindersRaw                              sql.NullString
		startAt, dueAt, completedAt, deletingAt, deletedAt sql.NullString
		repeatRule, repeatSeedID                           sql.NullString
		objectTypeID, propsJSON                            sql.NullString
		createdAt, updatedAt                               string
		dirty                                              int
	)
	if err := rows.Scan(
		&t.ID, &t.Title, &notesMD, &t.Status, &startAt, &dueAt, &remindersRaw, &completedAt,
		&repeatRule, &repeatSeedID, &objectTypeID, &propsJSON, &createdAt, &updatedAt, &deletingAt, &deletedAt, &t.Version, &dirty,
	); err != nil {
		return nil, fmt.Errorf("scan task: %w", err)
	}
	t.NotesMD = notesMD.String
	t.Reminders = parseReminders(remindersRaw.String)
	if objectTypeID.Valid {
		t.ObjectTypeID = &objectTypeID.String
	}
	t.Props = json.RawMessage(normalizeProps([]byte(propsJSON.String)))
	var err error
	if t.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if t.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	if t.StartAt, err = parseNullTime(startAt); err != nil {
		return nil, err
	}
	if t.DueAt, err = parseNullTime(dueAt); err != nil {
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
