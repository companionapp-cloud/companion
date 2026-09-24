package bridge

import (
	"encoding/json"
	"errors"
	"time"

	"companion/core/domain"
	"companion/core/store"
)

// pomodoroChangedEvent tells the timer surfaces (the desktop menu bar and its timer window, a
// task's stopwatch button) that a pomodoro started, settled or its break changed. Rows pulled by
// a sync arrive with the bulk data.changed every sync emits.
const pomodoroChangedEvent = "pomodoro.changed"

// pomodoroView is a pomodoro with what the timer surfaces show beside it. EndsAt and
// RemainingSec are as of the state's Now: a paused clock's end keeps moving out while its
// remaining time holds still, so a surface counts down from RemainingSec only while it runs.
type pomodoroView struct {
	*domain.Pomodoro
	EndsAt       time.Time `json:"endsAt"`
	RemainingSec int       `json:"remainingSec"`
	TaskTitle    string    `json:"taskTitle"`
}

// pomodoroState is everything a timer surface draws: the pomodoro running (if any) — the task
// it's on, if one is picked, and how many it has finished — the break earned by the last one that
// counted (if still on), the one that settled most recently (so a surface can say how it ended),
// and the day's tally.
type pomodoroState struct {
	Running *pomodoroView `json:"running"`
	// BreakEndsAt is when the break that is on ends; nil when there is none (or a pomodoro runs).
	BreakEndsAt *time.Time    `json:"breakEndsAt"`
	Last        *pomodoroView `json:"last"`
	// TodayCount counts the pomodoros that counted since the start of the caller's day.
	TodayCount int       `json:"todayCount"`
	Now        time.Time `json:"now"`
}

// pomodoroArgs is the shared payload: dayStart is the start of the caller's local day (the core
// may run where local time is UTC, as in the browser's wasm), used for the day's tally.
type pomodoroArgs struct {
	TaskID   string     `json:"taskId"`
	DayStart *time.Time `json:"dayStart"`
}

func (c *Core) pomodoroState(payload []byte) ([]byte, error) {
	var args pomodoroArgs
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	return c.pomodoroStateFor(args.DayStart)
}

// pomodoroStart puts a task in front of the pomodoro: the running one moves over to it (its clock
// keeps going), or a new one starts on it.
func (c *Core) pomodoroStart(payload []byte) ([]byte, error) {
	var args pomodoroArgs
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if _, err := c.store.Pomodoros.Start(args.TaskID); err != nil {
		return nil, mapStoreErr(err)
	}
	c.emit(pomodoroChangedEvent, nil)
	return c.pomodoroStateFor(args.DayStart)
}

// pomodoroComplete finishes the task the running pomodoro is on. That's the task update any other
// surface would make; settling then counts it toward the pomodoro, whose clock keeps running
// while the next task is picked.
func (c *Core) pomodoroComplete(payload []byte) ([]byte, error) {
	var args pomodoroArgs
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if _, err := c.store.Pomodoros.Settle(); err != nil {
		return nil, err
	}
	p, err := c.store.Pomodoros.Running()
	if err != nil {
		return nil, err
	}
	if p == nil {
		return nil, store.ErrNoPomodoro
	}
	if p.TaskID == "" {
		return nil, store.ErrNoTask
	}
	done := domain.TaskDone
	if _, err := c.store.Tasks.Update(p.TaskID, store.UpdateTaskInput{Status: &done}); err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitTaskChanged(p.TaskID)
	return c.pomodoroStateFor(args.DayStart)
}

// pomodoroCancel gives up the running pomodoro; it does not count.
func (c *Core) pomodoroCancel(payload []byte) ([]byte, error) {
	var args pomodoroArgs
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if _, err := c.store.Pomodoros.Settle(); err != nil {
		return nil, err
	}
	if _, err := c.store.Pomodoros.Cancel(); err != nil && !errors.Is(err, store.ErrNoPomodoro) {
		return nil, err
	}
	c.emit(pomodoroChangedEvent, nil)
	return c.pomodoroStateFor(args.DayStart)
}

// pomodoroPause stops the running pomodoro's clock.
func (c *Core) pomodoroPause(payload []byte) ([]byte, error) {
	var args pomodoroArgs
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if _, err := c.store.Pomodoros.Pause(); err != nil {
		return nil, err
	}
	c.emit(pomodoroChangedEvent, nil)
	return c.pomodoroStateFor(args.DayStart)
}

// pomodoroResume starts the running pomodoro's clock again (it needs a task in front of it).
func (c *Core) pomodoroResume(payload []byte) ([]byte, error) {
	var args pomodoroArgs
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if _, err := c.store.Pomodoros.Resume(); err != nil {
		return nil, err
	}
	c.emit(pomodoroChangedEvent, nil)
	return c.pomodoroStateFor(args.DayStart)
}

// pomodoroFinish ends the running pomodoro now — it counts, once a task was finished in it — and
// starts the break.
func (c *Core) pomodoroFinish(payload []byte) ([]byte, error) {
	var args pomodoroArgs
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if _, err := c.store.Pomodoros.Finish(); err != nil {
		return nil, err
	}
	c.emit(pomodoroChangedEvent, nil)
	return c.pomodoroStateFor(args.DayStart)
}

// pomodoroSkipBreak ends the break early.
func (c *Core) pomodoroSkipBreak(payload []byte) ([]byte, error) {
	var args pomodoroArgs
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if err := c.store.Pomodoros.SkipBreak(); err != nil {
		return nil, err
	}
	c.emit(pomodoroChangedEvent, nil)
	return c.pomodoroStateFor(args.DayStart)
}

// pomodoroStateFor settles whatever is decided (announcing it when anything changed) and
// reports the state. dayStart defaults to the start of today in this process's local time.
func (c *Core) pomodoroStateFor(dayStart *time.Time) ([]byte, error) {
	settled, err := c.store.Pomodoros.Settle()
	if err != nil {
		return nil, err
	}
	if settled {
		c.emit(pomodoroChangedEvent, nil)
	}
	now := time.Now()
	since := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	if dayStart != nil {
		since = *dayStart
	}
	state := pomodoroState{Now: now.UTC()}

	running, err := c.store.Pomodoros.Running()
	if err != nil {
		return nil, err
	}
	state.Running = c.pomodoroView(running, now)
	if running == nil {
		brk, err := c.store.Pomodoros.Break()
		if err != nil {
			return nil, err
		}
		if brk != nil {
			state.BreakEndsAt = brk.BreakEndsAt
		}
	}
	last, err := c.store.Pomodoros.Last()
	if err != nil {
		return nil, err
	}
	state.Last = c.pomodoroView(last, now)

	if state.TodayCount, err = c.store.Pomodoros.CountCompleted(since, ""); err != nil {
		return nil, err
	}
	return json.Marshal(state)
}

func (c *Core) pomodoroView(p *domain.Pomodoro, now time.Time) *pomodoroView {
	if p == nil {
		return nil
	}
	v := &pomodoroView{Pomodoro: p, EndsAt: p.EndsAt(now), RemainingSec: int(p.Remaining(now).Round(time.Second) / time.Second)}
	if !p.Running() && p.EndedAt != nil {
		// A settled pomodoro's end is when it ended, not a moving target.
		v.EndsAt, v.RemainingSec = *p.EndedAt, 0
	}
	if p.TaskID == "" {
		return v
	}
	if t, err := c.store.Tasks.Get(p.TaskID); err == nil {
		v.TaskTitle = t.Title
	}
	return v
}
