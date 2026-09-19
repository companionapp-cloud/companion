// Package notify computes notification *plans* — pure, testable computation shared by
// every platform (PLAN §6.4, §2). It decides what should fire and when; actually
// scheduling the OS notification is shell work (Wails / expo-notifications / the web
// Notification API). Keeping the planning here means every device produces the same plan
// from the same synced data.
package notify

import (
	"sort"
	"time"

	"companion/core/domain"
)

// Kinds of fire.
const (
	KindReminder = "reminder"
	KindDue      = "due"
)

// Notification is a single planned fire. FireAt is the instant the shell should surface it.
type Notification struct {
	TaskID string    `json:"taskId"`
	Kind   string    `json:"kind"`
	FireAt time.Time `json:"fireAt"`
	Title  string    `json:"title"`
	Body   string    `json:"body"`
}

// PlanTasks returns the notifications due to fire in the window (now, now+horizon], sorted
// by FireAt. Only open tasks contribute — a done, cancelled, trashed, or tombstoned task
// never notifies. Each of a task's reminders fires on its own (a relative one counted back
// from the deadline, PLAN §6.4); a task with a deadline but no reminders fires once, at its
// deadline.
func PlanTasks(tasks []*domain.Task, now time.Time, horizon time.Duration) []Notification {
	end := now.Add(horizon)
	out := []Notification{}
	for _, t := range tasks {
		if t == nil || t.Status != domain.TaskOpen || t.DeletedAt != nil || t.DeletingAt != nil {
			continue
		}
		for _, n := range taskFires(t) {
			if inWindow(n.FireAt, now, end) {
				out = append(out, n)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].FireAt.Equal(out[j].FireAt) {
			return out[i].TaskID < out[j].TaskID
		}
		return out[i].FireAt.Before(out[j].FireAt)
	})
	return out
}

// FeedItem is one entry in the in-app notification feed: a fire that already happened,
// plus whether its task has since settled (done/cancelled) so the UI can mute it.
type FeedItem struct {
	Notification
	Settled bool `json:"settled"`
}

// FeedTasks returns the fires that already happened in the trailing window [now-lookback,
// now], newest first — the in-app notification feed (the mirror image of PlanTasks, which
// looks forward). Trashed/deleted tasks drop out entirely; settled (done/cancelled) tasks
// keep their past fires as history, flagged Settled. The fires are exactly PlanTasks' (every
// reminder, or the deadline when there are none), so the feed lists what the OS surfaced.
func FeedTasks(tasks []*domain.Task, now time.Time, lookback time.Duration) []FeedItem {
	start := now.Add(-lookback)
	out := []FeedItem{}
	for _, t := range tasks {
		if t == nil || t.DeletedAt != nil || t.DeletingAt != nil {
			continue
		}
		settled := t.Status != domain.TaskOpen
		// (start, now] — a fire exactly at `now` has happened; one older than the lookback
		// has aged out of the feed.
		for _, n := range taskFires(t) {
			if inWindow(n.FireAt, start, now) {
				out = append(out, FeedItem{Settled: settled, Notification: n})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].FireAt.Equal(out[j].FireAt) {
			return out[i].TaskID < out[j].TaskID
		}
		return out[i].FireAt.After(out[j].FireAt)
	})
	return out
}

// SettledReminderIDs returns the ids of tasks whose reminder/due notification has already
// fired but that are now **settled** — completed, cancelled, trashed, or deleted — so the
// shell can dismiss any notification still sitting in the tray for them (PLAN §6.4). Cancelling
// a *pending* fire is handled by re-planning (a settled task drops out of PlanTasks); this
// covers the case a reminder already surfaced before the user finished the task. Bounded to
// fires within the trailing `horizon` so the list stays small (older notifications are long
// gone from the OS). A task with several fires is listed once.
func SettledReminderIDs(tasks []*domain.Task, now time.Time, horizon time.Duration) []string {
	lower := now.Add(-horizon)
	out := []string{}
	for _, t := range tasks {
		if t == nil {
			continue
		}
		if t.Status == domain.TaskOpen && t.DeletedAt == nil && t.DeletingAt == nil {
			continue // still an active task — keep its notification
		}
		for _, n := range taskFires(t) {
			// Neither in the future nor too old to still be shown.
			if !n.FireAt.After(now) && !n.FireAt.Before(lower) {
				out = append(out, t.ID)
				break
			}
		}
	}
	return out
}

// taskFires lists every notification a task produces over its life: one per resolved
// reminder, or — when it has no reminders — one at its deadline. A reminder landing exactly on
// the deadline reads "Due now", like the implicit one.
func taskFires(t *domain.Task) []Notification {
	title := t.Title
	if title == "" {
		title = "Untitled task"
	}
	if len(t.Reminders) == 0 {
		if t.DueAt == nil {
			return nil
		}
		return []Notification{{TaskID: t.ID, Kind: KindDue, FireAt: t.DueAt.UTC(), Title: title, Body: "Due now"}}
	}
	fires := t.ReminderFires()
	out := make([]Notification, 0, len(fires))
	for _, at := range fires {
		body := reminderBody(t)
		if t.DueAt != nil && at.Equal(*t.DueAt) {
			body = "Due now"
		}
		out = append(out, Notification{TaskID: t.ID, Kind: KindReminder, FireAt: at, Title: title, Body: body})
	}
	return out
}

// inWindow reports whether t lies in (start, end] — a future fire within the horizon. A
// fire exactly at `start` is treated as already past (the shell handles missed fires).
func inWindow(t, start, end time.Time) bool {
	return t.After(start) && !t.After(end)
}

func reminderBody(t *domain.Task) string {
	if t.DueAt != nil {
		return "Due " + t.DueAt.Local().Format("Mon Jan 2, 3:04 PM")
	}
	return "Reminder"
}
