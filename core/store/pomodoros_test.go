//go:build !js

package store

import (
	"errors"
	"testing"
	"time"

	"companion/core/domain"
)

func newPomodoroFixture(t *testing.T) (*Store, *fixedClock, *domain.Task) {
	t.Helper()
	clk := &fixedClock{t: time.Date(2026, 9, 24, 9, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)
	task, err := s.Tasks.Create(CreateTaskInput{Title: "Write report"})
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	return s, clk, task
}

func settle(t *testing.T, s *Store) {
	t.Helper()
	if _, err := s.Pomodoros.Settle(); err != nil {
		t.Fatalf("settle: %v", err)
	}
}

func finish(t *testing.T, s *Store, id string) {
	t.Helper()
	done := domain.TaskDone
	if _, err := s.Tasks.Update(id, UpdateTaskInput{Status: &done}); err != nil {
		t.Fatalf("complete task: %v", err)
	}
}

func running(t *testing.T, s *Store) *domain.Pomodoro {
	t.Helper()
	p, err := s.Pomodoros.Running()
	if err != nil {
		t.Fatalf("running: %v", err)
	}
	return p
}

func TestPomodoroFinishingATaskStopsTheClockUntilTheNextIsPicked(t *testing.T) {
	s, clk, task := newPomodoroFixture(t)
	next, _ := s.Tasks.Create(CreateTaskInput{Title: "Inbox zero"})
	p, err := s.Pomodoros.Start(task.ID)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if !p.Running() || !p.Dirty || p.DurationSec != 25*60 || p.TaskID != task.ID || p.Paused() {
		t.Fatalf("started = %+v", p)
	}

	// Finishing the task counts toward the pomodoro, frees it, and stops the clock with 15
	// minutes left.
	clk.t = clk.t.Add(10 * time.Minute)
	finish(t, s, task.ID)
	settle(t, s)
	got := running(t, s)
	if got == nil || got.ID != p.ID || got.TaskID != "" || got.TasksDone != 1 || !got.Paused() {
		t.Fatalf("after finishing = %+v, want running, paused, no task, 1 done", got)
	}
	if brk, _ := s.Pomodoros.Break(); brk != nil {
		t.Errorf("a break started mid-pomodoro: %+v", brk)
	}

	// Stopped for five minutes: nothing runs out, and the time left holds.
	clk.t = clk.t.Add(5 * time.Minute)
	settle(t, s)
	got = running(t, s)
	if got == nil || got.Remaining(clk.t) != 15*time.Minute {
		t.Fatalf("while stopped = %+v, want 15m left", got)
	}
	if _, err := s.Pomodoros.Resume(); !errors.Is(err, ErrNoTask) {
		t.Errorf("resume with no task: err = %v, want ErrNoTask", err)
	}

	// Picking the next task starts the clock again on the same pomodoro, its end pushed out by
	// the pause.
	moved, err := s.Pomodoros.Start(next.ID)
	if err != nil {
		t.Fatalf("pick next: %v", err)
	}
	if moved.ID != p.ID || moved.TaskID != next.ID || moved.TasksDone != 1 || moved.Paused() || moved.PausedSec != 5*60 {
		t.Fatalf("after picking = %+v", moved)
	}
	endsAt := p.StartedAt.Add(30 * time.Minute)
	if !moved.EndsAt(clk.t).Equal(endsAt) {
		t.Fatalf("ends at %v, want %v", moved.EndsAt(clk.t), endsAt)
	}

	// When the clock runs out it counts — one task was finished — and the break starts then.
	clk.t = endsAt.Add(time.Second)
	settle(t, s)
	ended, _ := s.Pomodoros.GetAny(p.ID)
	if ended.Outcome != domain.PomodoroCompleted || !ended.EndedAt.Equal(endsAt) || ended.TaskID != next.ID {
		t.Fatalf("settled = %+v", ended)
	}
	brk, err := s.Pomodoros.Break()
	if err != nil || brk == nil || !brk.BreakEndsAt.Equal(endsAt.Add(5*time.Minute)) {
		t.Fatalf("break = %+v, %v", brk, err)
	}
	if n, _ := s.Pomodoros.CountCompleted(clk.t.Add(-time.Hour), ""); n != 1 {
		t.Errorf("count = %d, want 1", n)
	}

	if err := s.Pomodoros.SkipBreak(); err != nil {
		t.Fatalf("skip break: %v", err)
	}
	if brk, _ := s.Pomodoros.Break(); brk != nil {
		t.Errorf("break still on after skipping: %+v", brk)
	}
}

func TestPomodoroPauseAndResume(t *testing.T) {
	s, clk, task := newPomodoroFixture(t)
	p, _ := s.Pomodoros.Start(task.ID)
	clk.t = clk.t.Add(20 * time.Minute)
	if _, err := s.Pomodoros.Pause(); err != nil {
		t.Fatalf("pause: %v", err)
	}
	// Paused well past where it would have run out: it doesn't.
	clk.t = clk.t.Add(time.Hour)
	settle(t, s)
	got := running(t, s)
	if got == nil || !got.Paused() || got.Remaining(clk.t) != 5*time.Minute {
		t.Fatalf("paused = %+v, want still running with 5m left", got)
	}
	resumed, err := s.Pomodoros.Resume()
	if err != nil || resumed.Paused() || resumed.TaskID != task.ID || resumed.Remaining(clk.t) != 5*time.Minute {
		t.Fatalf("resume = %+v, %v", resumed, err)
	}
	clk.t = clk.t.Add(5 * time.Minute)
	settle(t, s)
	if ended, _ := s.Pomodoros.GetAny(p.ID); ended.Outcome != domain.PomodoroExpired {
		t.Errorf("outcome = %q, want expired (nothing finished)", ended.Outcome)
	}
}

func TestPomodoroFinishingSeveralTasksCountsOnce(t *testing.T) {
	s, clk, task := newPomodoroFixture(t)
	second, _ := s.Tasks.Create(CreateTaskInput{Title: "Second"})
	p, _ := s.Pomodoros.Start(task.ID)
	clk.t = clk.t.Add(5 * time.Minute)
	finish(t, s, task.ID)
	if _, err := s.Pomodoros.Start(second.ID); err != nil {
		t.Fatalf("pick next: %v", err)
	}
	clk.t = clk.t.Add(5 * time.Minute)
	finish(t, s, second.ID)
	settle(t, s)
	got := running(t, s)
	if got == nil || got.TasksDone != 2 || !got.Paused() {
		t.Fatalf("running = %+v, want 2 done and stopped", got)
	}
	// Stopped waiting for a next task, it would wait for good; done for now, it counts.
	clk.t = p.EndsAt(p.StartedAt).Add(time.Hour)
	settle(t, s)
	if running(t, s) == nil {
		t.Fatal("a stopped pomodoro ran out")
	}
	ended, err := s.Pomodoros.Finish()
	if err != nil || ended.Outcome != domain.PomodoroCompleted || !ended.EndedAt.Equal(clk.t) || ended.BreakEndsAt == nil {
		t.Fatalf("finish = %+v, %v", ended, err)
	}
	if n, _ := s.Pomodoros.CountCompleted(time.Time{}, ""); n != 1 {
		t.Errorf("count = %d, want the one pomodoro", n)
	}
}

func TestPomodoroFinishNeedsAFinishedTask(t *testing.T) {
	s, _, task := newPomodoroFixture(t)
	if _, err := s.Pomodoros.Start(task.ID); err != nil {
		t.Fatalf("start: %v", err)
	}
	if _, err := s.Pomodoros.Finish(); !errors.Is(err, domain.ErrInvalidPomodoro) {
		t.Errorf("finish with nothing done: err = %v", err)
	}
}

func TestPomodoroRunningOutWithNothingFinishedEarnsNothing(t *testing.T) {
	s, clk, task := newPomodoroFixture(t)
	p, _ := s.Pomodoros.Start(task.ID)
	clk.t = clk.t.Add(24 * time.Minute)
	settle(t, s)
	if running(t, s) == nil {
		t.Fatal("still inside the window, want running")
	}

	clk.t = clk.t.Add(2 * time.Minute)
	settle(t, s)
	got, _ := s.Pomodoros.GetAny(p.ID)
	if got.Outcome != domain.PomodoroExpired || !got.EndedAt.Equal(p.EndsAt(p.StartedAt)) || got.BreakEndsAt != nil {
		t.Fatalf("settled = %+v", got)
	}

	// Finishing the task afterwards doesn't retroactively count.
	finish(t, s, task.ID)
	settle(t, s)
	if n, _ := s.Pomodoros.CountCompleted(time.Time{}, ""); n != 0 {
		t.Errorf("count = %d, want 0", n)
	}
}

func TestPomodoroFinishedLateWhileNobodyLookedEarnsNothing(t *testing.T) {
	// The app was away through the end of the window and the task was finished later on another
	// device: settling afterwards sees a completion past the window.
	s, clk, task := newPomodoroFixture(t)
	p, _ := s.Pomodoros.Start(task.ID)
	clk.t = clk.t.Add(40 * time.Minute)
	finish(t, s, task.ID)
	settle(t, s)
	got, _ := s.Pomodoros.GetAny(p.ID)
	if got.Outcome != domain.PomodoroExpired || got.TasksDone != 0 {
		t.Fatalf("settled = %+v, want expired with nothing done", got)
	}
}

func TestPomodoroStopwatchOnAnotherTaskMovesTheRunningOne(t *testing.T) {
	s, clk, task := newPomodoroFixture(t)
	other, _ := s.Tasks.Create(CreateTaskInput{Title: "Inbox zero"})

	first, _ := s.Pomodoros.Start(task.ID)
	clk.t = clk.t.Add(time.Minute)
	moved, err := s.Pomodoros.Start(other.ID)
	if err != nil {
		t.Fatalf("start on another task: %v", err)
	}
	if moved.ID != first.ID || moved.TaskID != other.ID || !moved.StartedAt.Equal(first.StartedAt) {
		t.Fatalf("moved = %+v, want the same pomodoro on the other task", moved)
	}

	cancelled, err := s.Pomodoros.Cancel()
	if err != nil || cancelled.Outcome != domain.PomodoroCancelled {
		t.Fatalf("cancel = %+v, %v", cancelled, err)
	}
	if _, err := s.Pomodoros.Cancel(); !errors.Is(err, ErrNoPomodoro) {
		t.Errorf("cancel with none running: err = %v, want ErrNoPomodoro", err)
	}
	if n, _ := s.Pomodoros.CountCompleted(time.Time{}, ""); n != 0 {
		t.Errorf("count = %d, want 0", n)
	}
}

func TestPomodoroTrashedTaskFreesIt(t *testing.T) {
	s, _, task := newPomodoroFixture(t)
	p, _ := s.Pomodoros.Start(task.ID)
	if err := s.Tasks.Trash(task.ID); err != nil {
		t.Fatalf("trash: %v", err)
	}
	settle(t, s)
	got := running(t, s)
	if got == nil || got.ID != p.ID || got.TaskID != "" || got.TasksDone != 0 || !got.Paused() {
		t.Errorf("running = %+v, want still running, stopped, with no task and nothing done", got)
	}
}

func TestPomodoroStartRejectsFinishedOrMissingTasks(t *testing.T) {
	s, _, task := newPomodoroFixture(t)
	finish(t, s, task.ID)
	if _, err := s.Pomodoros.Start(task.ID); !errors.Is(err, domain.ErrInvalidPomodoro) {
		t.Errorf("start on done task: err = %v", err)
	}
	if _, err := s.Pomodoros.Start("nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("start on missing task: err = %v", err)
	}
}

func TestPomodoroSyncRoundTrip(t *testing.T) {
	s, clk, task := newPomodoroFixture(t)
	p, _ := s.Pomodoros.Start(task.ID)
	dirty, err := s.Pomodoros.Dirty()
	if err != nil || len(dirty) != 1 {
		t.Fatalf("dirty = %v, %v", dirty, err)
	}

	// Another device applies the row, settled.
	other := newTestStore(t, clk)
	ended := p.EndsAt(p.StartedAt)
	brk := ended.Add(domain.PomodoroBreak)
	p.Outcome, p.EndedAt, p.BreakEndsAt, p.TasksDone, p.Version = domain.PomodoroCompleted, &ended, &brk, 2, 3
	if err := other.Pomodoros.Apply(p); err != nil {
		t.Fatalf("apply: %v", err)
	}
	got, err := other.Pomodoros.GetAny(p.ID)
	if err != nil || got.Dirty || got.Version != 3 || got.Outcome != domain.PomodoroCompleted || got.TasksDone != 2 || !got.BreakEndsAt.Equal(brk) {
		t.Fatalf("applied = %+v, %v", got, err)
	}
	if n, _ := other.Pomodoros.CountCompleted(clk.t, ""); n != 1 {
		t.Errorf("count on other device = %d, want 1", n)
	}
}
