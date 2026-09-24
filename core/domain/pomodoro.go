package domain

import (
	"errors"
	"strings"
	"time"
)

// Pomodoro is one timed focus block: DurationSec of work, one task at a time. Finishing that task
// counts toward the pomodoro, frees it for the next (TaskID goes empty until one is picked) and
// stops its clock until then; the user can stop the clock too. When the clock runs out the
// pomodoro counts — and earns a break — if at least one task was finished in it; otherwise, or
// if it's given up, it earns nothing. A row starts with no Outcome (running) and
// is settled exactly once, into one of the outcomes below.
type Pomodoro struct {
	ID string `json:"id"`
	// TaskID is the task being worked on; empty while waiting for the next one.
	TaskID string `json:"taskId"`
	// TasksDone counts the tasks finished inside the window.
	TasksDone int `json:"tasksDone"`
	// StartedAt, DurationSec and the time spent paused fix the window; see EndsAt.
	StartedAt   time.Time `json:"startedAt"`
	DurationSec int       `json:"durationSec"`
	// PausedAt is when the clock stopped; nil while it runs.
	PausedAt *time.Time `json:"pausedAt,omitempty"`
	// PausedSec is the time spent paused before PausedAt, which pushes the end out.
	PausedSec int `json:"pausedSec"`
	// Outcome is empty while the pomodoro runs.
	Outcome string `json:"outcome"`
	// EndedAt is when it settled: the end of the window for a completed or expired one, the
	// moment it was given up for a cancelled one.
	EndedAt *time.Time `json:"endedAt,omitempty"`
	// BreakEndsAt closes the break a completed pomodoro earns; skipping the break moves it to
	// the moment it was skipped. Nil for every other outcome.
	BreakEndsAt *time.Time `json:"breakEndsAt,omitempty"`
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
	DeletedAt   *time.Time `json:"deletedAt,omitempty"`
	Version     int64      `json:"version"`
	Dirty       bool       `json:"dirty"`
}

// How a pomodoro settled. Only a completed one — at least one task finished in its window —
// counts.
const (
	PomodoroCompleted = "completed"
	PomodoroExpired   = "expired"
	PomodoroCancelled = "cancelled"
)

// The classic lengths: 25 minutes of focus, then a 5 minute break after one that counts.
const (
	PomodoroDuration = 25 * time.Minute
	PomodoroBreak    = 5 * time.Minute
)

// ErrInvalidPomodoro is returned when a pomodoro fails validation.
var ErrInvalidPomodoro = errors.New("invalid pomodoro")

// EndsAt is when the pomodoro's clock runs out, as of now: its duration after it started, pushed
// out by the time spent paused — including, while it is paused, the pause so far.
func (p *Pomodoro) EndsAt(now time.Time) time.Time {
	end := p.StartedAt.Add(time.Duration(p.DurationSec+p.PausedSec) * time.Second)
	if p.PausedAt != nil && now.After(*p.PausedAt) {
		end = end.Add(now.Sub(*p.PausedAt))
	}
	return end
}

// Remaining is the time left on the clock as of now; it holds still while paused.
func (p *Pomodoro) Remaining(now time.Time) time.Duration {
	if left := p.EndsAt(now).Sub(now); left > 0 {
		return left
	}
	return 0
}

// Paused reports whether the clock is stopped.
func (p *Pomodoro) Paused() bool { return p.PausedAt != nil }

// Running reports whether the pomodoro has yet to settle.
func (p *Pomodoro) Running() bool { return p.Outcome == "" }

// Validate checks the invariants that must hold before a row is persisted.
func (p *Pomodoro) Validate() error {
	if strings.TrimSpace(p.ID) == "" {
		return errors.Join(ErrInvalidPomodoro, errors.New("id is required"))
	}
	if p.DurationSec <= 0 {
		return errors.Join(ErrInvalidPomodoro, errors.New("durationSec must be positive"))
	}
	switch p.Outcome {
	case "":
	case PomodoroCompleted, PomodoroExpired, PomodoroCancelled:
		if p.EndedAt == nil {
			return errors.Join(ErrInvalidPomodoro, errors.New("a settled pomodoro has an endedAt"))
		}
	default:
		return errors.Join(ErrInvalidPomodoro, errors.New("outcome must be completed, expired or cancelled"))
	}
	return nil
}

// SyncEntity implementation (PLAN §7).
func (p *Pomodoro) SyncID() string           { return p.ID }
func (p *Pomodoro) SyncVersion() int64       { return p.Version }
func (p *Pomodoro) SyncUpdatedAt() time.Time { return p.UpdatedAt }
func (p *Pomodoro) SyncDeleted() bool        { return p.DeletedAt != nil }
func (p *Pomodoro) SyncDirty() bool          { return p.Dirty }
