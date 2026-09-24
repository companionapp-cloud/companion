package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"companion/core/domain"
	"companion/core/sync/protocol"
)

// PomodorosRepo keeps the user's pomodoros: 25-minute focus blocks, one task at a time, that
// count when at least one task was finished inside them. One runs at a time; the rows sync, so
// the tally follows the user between devices.
type PomodorosRepo struct {
	db    Driver
	clock domain.Clock
}

const pomodoroColumns = `id, task_id, started_at, duration_sec, outcome, ended_at, break_ends_at, created_at, updated_at, deleted_at, version, dirty, tasks_done, paused_at, paused_sec`

// pomodoroTimeFormat keeps every instant in the table fixed-width UTC, so the queries can
// compare them as strings (RFC3339Nano trims trailing zeros, which breaks string order).
const pomodoroTimeFormat = "2006-01-02T15:04:05.000000000Z07:00"

func pomodoroTime(t time.Time) string { return t.UTC().Format(pomodoroTimeFormat) }

func pomodoroNullTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return pomodoroTime(*t)
}

// ErrNoPomodoro is returned when an action needs a running pomodoro and none is.
var ErrNoPomodoro = errors.New("no pomodoro is running")

// Start puts a live, open task in front of the pomodoro. With one running, it moves over to the
// task and its clock runs again if it was stopped (the stopwatch on another task, or picking the
// next one after finishing); otherwise a new pomodoro starts on it.
func (r *PomodorosRepo) Start(taskID string) (*domain.Pomodoro, error) {
	if _, err := r.Settle(); err != nil {
		return nil, err
	}
	task, err := r.task(taskID)
	if err != nil {
		return nil, err
	}
	if task == nil || task.deletedAt.Valid || task.deletingAt.Valid {
		return nil, ErrNotFound
	}
	if task.status != domain.TaskOpen {
		return nil, errors.Join(domain.ErrInvalidPomodoro, errors.New("the task is already finished"))
	}
	now := r.clock.Now().UTC()
	running, err := r.Running()
	if err != nil {
		return nil, err
	}
	if running != nil {
		if running.TaskID != taskID || running.Paused() {
			running.TaskID = taskID
			resume(running, now)
			if err := r.write(running, now); err != nil {
				return nil, err
			}
		}
		return r.GetAny(running.ID)
	}
	// Getting back to work ends any break that is still on.
	if err := r.SkipBreak(); err != nil {
		return nil, err
	}
	p := &domain.Pomodoro{
		ID: uuid.NewString(), TaskID: taskID, StartedAt: now, DurationSec: int(domain.PomodoroDuration / time.Second),
		CreatedAt: now, UpdatedAt: now, Dirty: true,
	}
	if err := p.Validate(); err != nil {
		return nil, err
	}
	if _, err := r.db.Exec(
		`INSERT INTO pomodoros (`+pomodoroColumns+`) VALUES (?, ?, ?, ?, '', NULL, NULL, ?, ?, NULL, 0, 1, 0, NULL, 0);`,
		p.ID, p.TaskID, pomodoroTime(p.StartedAt), p.DurationSec, pomodoroTime(p.CreatedAt), pomodoroTime(p.UpdatedAt),
	); err != nil {
		return nil, fmt.Errorf("insert pomodoro: %w", err)
	}
	return p, nil
}

// Settle brings every running pomodoro up to date and reports whether it changed any. Its task,
// finished before the clock ran out, counts toward it, frees it for the next and stops the clock
// (from the moment it was finished) until the next is picked; a task that's gone or cancelled
// frees it and stops the clock too, and one finished too late just frees it. Once a running clock
// has run out it settles: completed (with a break from then) if any task was finished in it,
// expired if none was. Settling on read rather than on a timer means a pomodoro left running while the
// app was closed still ends the way it should, and a task finished anywhere — the editor, a
// list, the assistant, another device — counts.
func (r *PomodorosRepo) Settle() (bool, error) {
	running, err := r.list(`SELECT ` + pomodoroColumns + ` FROM pomodoros WHERE outcome = '' AND deleted_at IS NULL;`)
	if err != nil {
		return false, err
	}
	now := r.clock.Now().UTC()
	changed := false
	for _, p := range running {
		next, err := r.advance(p, now)
		if err != nil {
			return changed, err
		}
		if next.TaskID == p.TaskID && next.TasksDone == p.TasksDone && next.Paused() == p.Paused() && next.Outcome == "" {
			continue
		}
		if err := r.write(next, now); err != nil {
			return changed, err
		}
		changed = true
	}
	return changed, nil
}

// advance works out where a running pomodoro stands as of now (see Settle).
func (r *PomodorosRepo) advance(p *domain.Pomodoro, now time.Time) (*domain.Pomodoro, error) {
	next := *p
	endsAt := p.EndsAt(now)
	stop := func(at time.Time) {
		if next.PausedAt == nil {
			next.PausedAt = &at
		}
	}
	if p.TaskID != "" {
		task, err := r.task(p.TaskID)
		switch {
		case err != nil:
			return nil, err
		case task == nil:
			// Picked on another device, and the task hasn't synced here yet: leave it be.
		case task.deletedAt.Valid || task.deletingAt.Valid || task.status == domain.TaskCancelled:
			next.TaskID = ""
			stop(now)
		case task.status == domain.TaskDone:
			done, err := parseNullTime(task.completedAt)
			if err != nil {
				return nil, err
			}
			if done == nil {
				done = &now
			}
			// Finished after the clock ran out (the app was away): it frees the pomodoro but
			// doesn't count toward it, and the clock has already run out.
			if !done.After(endsAt) {
				next.TasksDone++
				stop(done.UTC())
			}
			next.TaskID = ""
		}
	}
	if !next.Paused() && !now.Before(endsAt) {
		next.Outcome = domain.PomodoroExpired
		if next.TasksDone > 0 {
			next.Outcome = domain.PomodoroCompleted
		}
		next.EndedAt = &endsAt
	}
	return &next, nil
}

// resume starts a stopped clock again, banking the time it spent stopped.
func resume(p *domain.Pomodoro, now time.Time) {
	if p.PausedAt == nil {
		return
	}
	if now.After(*p.PausedAt) {
		p.PausedSec += int(now.Sub(*p.PausedAt).Round(time.Second) / time.Second)
	}
	p.PausedAt = nil
}

// Pause stops the running pomodoro's clock.
func (r *PomodorosRepo) Pause() (*domain.Pomodoro, error) {
	if _, err := r.Settle(); err != nil {
		return nil, err
	}
	p, err := r.Running()
	if err != nil {
		return nil, err
	}
	if p == nil {
		return nil, ErrNoPomodoro
	}
	if p.Paused() {
		return p, nil
	}
	now := r.clock.Now().UTC()
	p.PausedAt = &now
	if err := r.write(p, now); err != nil {
		return nil, err
	}
	return r.GetAny(p.ID)
}

// Finish ends the running pomodoro now, ahead of its clock — done for this one, once at least one
// task was finished in it (while its clock waits on the next task, say). It counts, and the break
// starts now.
func (r *PomodorosRepo) Finish() (*domain.Pomodoro, error) {
	if _, err := r.Settle(); err != nil {
		return nil, err
	}
	p, err := r.Running()
	if err != nil {
		return nil, err
	}
	if p == nil {
		return nil, ErrNoPomodoro
	}
	if p.TasksDone == 0 {
		return nil, errors.Join(domain.ErrInvalidPomodoro, errors.New("finish a task first — or cancel"))
	}
	now := r.clock.Now().UTC()
	p.Outcome, p.EndedAt = domain.PomodoroCompleted, &now
	if err := r.write(p, now); err != nil {
		return nil, err
	}
	return r.GetAny(p.ID)
}

// ErrNoTask is returned when the clock can't run because the pomodoro has no task in front of it.
var ErrNoTask = errors.New("pick the next task first")

// Resume starts the running pomodoro's clock again. It needs a task to work on: without one,
// picking it (Start) is what resumes.
func (r *PomodorosRepo) Resume() (*domain.Pomodoro, error) {
	if _, err := r.Settle(); err != nil {
		return nil, err
	}
	p, err := r.Running()
	if err != nil {
		return nil, err
	}
	if p == nil {
		return nil, ErrNoPomodoro
	}
	if p.TaskID == "" {
		return nil, ErrNoTask
	}
	if !p.Paused() {
		return p, nil
	}
	now := r.clock.Now().UTC()
	resume(p, now)
	if err := r.write(p, now); err != nil {
		return nil, err
	}
	return r.GetAny(p.ID)
}

// pomodoroTask is what settling needs to know about a pomodoro's task.
type pomodoroTask struct {
	status                             string
	completedAt, deletingAt, deletedAt sql.NullString
}

// task reads a task's status, including a trashed or deleted one; nil when there is no row.
func (r *PomodorosRepo) task(id string) (*pomodoroTask, error) {
	rows, err := r.db.Query(`SELECT status, completed_at, deleting_at, deleted_at FROM tasks WHERE id = ?;`, id)
	if err != nil {
		return nil, fmt.Errorf("read task: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	var t pomodoroTask
	if err := rows.Scan(&t.status, &t.completedAt, &t.deletingAt, &t.deletedAt); err != nil {
		return nil, fmt.Errorf("scan task: %w", err)
	}
	return &t, nil
}

// write saves a running pomodoro's progress, or settles it when p carries an outcome (a
// completed one gets its break).
func (r *PomodorosRepo) write(p *domain.Pomodoro, now time.Time) error {
	if p.Outcome == domain.PomodoroCompleted && p.EndedAt != nil {
		b := p.EndedAt.Add(domain.PomodoroBreak)
		p.BreakEndsAt = &b
	}
	if _, err := r.db.Exec(
		`UPDATE pomodoros SET task_id = ?, tasks_done = ?, paused_at = ?, paused_sec = ?, outcome = ?, ended_at = ?, break_ends_at = ?,
		   updated_at = ?, dirty = 1
		 WHERE id = ? AND outcome = '';`,
		p.TaskID, p.TasksDone, pomodoroNullTime(p.PausedAt), p.PausedSec, p.Outcome, pomodoroNullTime(p.EndedAt), pomodoroNullTime(p.BreakEndsAt),
		pomodoroTime(now), p.ID,
	); err != nil {
		return fmt.Errorf("update pomodoro: %w", err)
	}
	return nil
}

// Cancel gives up the running pomodoro (every one, should two devices have started one before
// syncing): it ends now and does not count. Returns the one Running reported.
func (r *PomodorosRepo) Cancel() (*domain.Pomodoro, error) {
	p, err := r.Running()
	if err != nil {
		return nil, err
	}
	if p == nil {
		return nil, ErrNoPomodoro
	}
	running, err := r.list(`SELECT ` + pomodoroColumns + ` FROM pomodoros WHERE outcome = '' AND deleted_at IS NULL;`)
	if err != nil {
		return nil, err
	}
	now := r.clock.Now().UTC()
	for _, q := range running {
		q.Outcome, q.EndedAt = domain.PomodoroCancelled, &now
		if err := r.write(q, now); err != nil {
			return nil, err
		}
	}
	return r.GetAny(p.ID)
}

// Running returns the pomodoro still running, or nil. Call Settle first for an answer that is
// current. Should two devices each have started one before syncing, the latest wins.
func (r *PomodorosRepo) Running() (*domain.Pomodoro, error) {
	rows, err := r.list(`SELECT ` + pomodoroColumns + ` FROM pomodoros WHERE outcome = '' AND deleted_at IS NULL ORDER BY started_at DESC LIMIT 1;`)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0], nil
}

// Break returns the completed pomodoro whose break is still on as of now, or nil.
func (r *PomodorosRepo) Break() (*domain.Pomodoro, error) {
	now := pomodoroTime(r.clock.Now())
	rows, err := r.list(
		`SELECT `+pomodoroColumns+` FROM pomodoros WHERE outcome = ? AND break_ends_at > ? AND deleted_at IS NULL ORDER BY break_ends_at DESC LIMIT 1;`,
		domain.PomodoroCompleted, now,
	)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0], nil
}

// Last returns the pomodoro that settled most recently, or nil.
func (r *PomodorosRepo) Last() (*domain.Pomodoro, error) {
	rows, err := r.list(`SELECT ` + pomodoroColumns + ` FROM pomodoros WHERE outcome <> '' AND deleted_at IS NULL ORDER BY ended_at DESC LIMIT 1;`)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0], nil
}

// SkipBreak ends the break that is on, if any.
func (r *PomodorosRepo) SkipBreak() error {
	now := pomodoroTime(r.clock.Now())
	if _, err := r.db.Exec(
		`UPDATE pomodoros SET break_ends_at = ?, updated_at = ?, dirty = 1 WHERE outcome = ? AND break_ends_at > ? AND deleted_at IS NULL;`,
		now, now, domain.PomodoroCompleted, now,
	); err != nil {
		return fmt.Errorf("skip break: %w", err)
	}
	return nil
}

// CountCompleted counts the pomodoros that earned credit since the given instant; with a task
// id, only that task's.
func (r *PomodorosRepo) CountCompleted(since time.Time, taskID string) (int, error) {
	query := `SELECT COUNT(*) FROM pomodoros WHERE outcome = ? AND ended_at >= ? AND deleted_at IS NULL`
	args := []any{domain.PomodoroCompleted, pomodoroTime(since)}
	if taskID != "" {
		query += ` AND task_id = ?`
		args = append(args, taskID)
	}
	rows, err := r.db.Query(query+`;`, args...)
	if err != nil {
		return 0, fmt.Errorf("count pomodoros: %w", err)
	}
	defer rows.Close()
	var n int
	if rows.Next() {
		if err := rows.Scan(&n); err != nil {
			return 0, fmt.Errorf("count pomodoros: %w", err)
		}
	}
	return n, rows.Err()
}

func (r *PomodorosRepo) list(query string, args ...any) ([]*domain.Pomodoro, error) {
	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query pomodoros: %w", err)
	}
	defer rows.Close()
	out := []*domain.Pomodoro{}
	for rows.Next() {
		p, err := scanPomodoro(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// --- SyncableRepo[*domain.Pomodoro] ---

func (r *PomodorosRepo) EntityType() string { return protocol.EntityPomodoro }

func (r *PomodorosRepo) Dirty() ([]*domain.Pomodoro, error) {
	return r.list(`SELECT ` + pomodoroColumns + ` FROM pomodoros WHERE dirty = 1 ORDER BY updated_at ASC, id ASC;`)
}

func (r *PomodorosRepo) GetAny(id string) (*domain.Pomodoro, error) {
	rows, err := r.list(`SELECT `+pomodoroColumns+` FROM pomodoros WHERE id = ?;`, id)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, ErrNotFound
	}
	return rows[0], nil
}

func (r *PomodorosRepo) Apply(p *domain.Pomodoro) error {
	if _, err := r.db.Exec(
		`INSERT INTO pomodoros (`+pomodoroColumns+`)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   task_id = excluded.task_id, tasks_done = excluded.tasks_done,
		   paused_at = excluded.paused_at, paused_sec = excluded.paused_sec, started_at = excluded.started_at, duration_sec = excluded.duration_sec,
		   outcome = excluded.outcome, ended_at = excluded.ended_at, break_ends_at = excluded.break_ends_at,
		   created_at = excluded.created_at, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
		   version = excluded.version, dirty = 0;`,
		p.ID, p.TaskID, pomodoroTime(p.StartedAt), p.DurationSec, p.Outcome, pomodoroNullTime(p.EndedAt), pomodoroNullTime(p.BreakEndsAt),
		pomodoroTime(p.CreatedAt), pomodoroTime(p.UpdatedAt), pomodoroNullTime(p.DeletedAt), p.Version, p.TasksDone,
		pomodoroNullTime(p.PausedAt), p.PausedSec,
	); err != nil {
		return fmt.Errorf("apply pomodoro: %w", err)
	}
	return nil
}

func (r *PomodorosRepo) MarkPushed(id string, version int64) error {
	if _, err := r.db.Exec(`UPDATE pomodoros SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark pushed: %w", err)
	}
	return nil
}

// MeaningfulDiff: a pomodoro is a timer, not content — whichever write is newer wins.
func (r *PomodorosRepo) MeaningfulDiff(a, b *domain.Pomodoro) bool { return false }

// ConflictedCopy is a no-op (never invoked, since MeaningfulDiff is always false).
func (r *PomodorosRepo) ConflictedCopy(local *domain.Pomodoro, suffix string) error { return nil }

func (r *PomodorosRepo) Decode(raw json.RawMessage) (*domain.Pomodoro, error) {
	var p domain.Pomodoro
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("decode pomodoro: %w", err)
	}
	return &p, nil
}

func scanPomodoro(rows Rows) (*domain.Pomodoro, error) {
	var (
		p                                         domain.Pomodoro
		endedAt, breakEndsAt, deletedAt, pausedAt sql.NullString
		startedAt, createdAt, updatedAt           string
		dirty                                     int
	)
	if err := rows.Scan(&p.ID, &p.TaskID, &startedAt, &p.DurationSec, &p.Outcome, &endedAt, &breakEndsAt,
		&createdAt, &updatedAt, &deletedAt, &p.Version, &dirty, &p.TasksDone, &pausedAt, &p.PausedSec); err != nil {
		return nil, fmt.Errorf("scan pomodoro: %w", err)
	}
	var err error
	if p.StartedAt, err = time.Parse(timeFormat, startedAt); err != nil {
		return nil, fmt.Errorf("parse started_at: %w", err)
	}
	if p.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if p.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	if p.EndedAt, err = parseNullTime(endedAt); err != nil {
		return nil, err
	}
	if p.BreakEndsAt, err = parseNullTime(breakEndsAt); err != nil {
		return nil, err
	}
	if p.PausedAt, err = parseNullTime(pausedAt); err != nil {
		return nil, err
	}
	if p.DeletedAt, err = parseNullTime(deletedAt); err != nil {
		return nil, err
	}
	p.Dirty = dirty != 0
	return &p, nil
}
