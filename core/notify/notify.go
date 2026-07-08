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
// never notifies. A task's explicit reminder (RemindAt) fires as a reminder; a task with a
// due date but no reminder fires a due notification at its due time.
func PlanTasks(tasks []*domain.Task, now time.Time, horizon time.Duration) []Notification {
	end := now.Add(horizon)
	out := []Notification{}
	for _, t := range tasks {
		if t == nil || t.Status != domain.TaskOpen || t.DeletedAt != nil || t.DeletingAt != nil {
			continue
		}
		title := t.Title
		if title == "" {
			title = "Untitled task"
		}
		switch {
		case t.RemindAt != nil && inWindow(*t.RemindAt, now, end):
			out = append(out, Notification{
				TaskID: t.ID, Kind: KindReminder, FireAt: t.RemindAt.UTC(),
				Title: title, Body: reminderBody(t),
			})
		case t.RemindAt == nil && t.DueAt != nil && inWindow(*t.DueAt, now, end):
			out = append(out, Notification{
				TaskID: t.ID, Kind: KindDue, FireAt: t.DueAt.UTC(),
				Title: title, Body: "Due now",
			})
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
// keep their past fires as history, flagged Settled. The reminder-over-due precedence
// matches PlanTasks so the feed lists exactly what the OS surfaced.
func FeedTasks(tasks []*domain.Task, now time.Time, lookback time.Duration) []FeedItem {
	start := now.Add(-lookback)
	out := []FeedItem{}
	for _, t := range tasks {
		if t == nil || t.DeletedAt != nil || t.DeletingAt != nil {
			continue
		}
		title := t.Title
		if title == "" {
			title = "Untitled task"
		}
		settled := t.Status != domain.TaskOpen
		// (start, now] — a fire exactly at `now` has happened; one older than the lookback
		// has aged out of the feed.
		switch {
		case t.RemindAt != nil && inWindow(*t.RemindAt, start, now):
			out = append(out, FeedItem{Settled: settled, Notification: Notification{
				TaskID: t.ID, Kind: KindReminder, FireAt: t.RemindAt.UTC(),
				Title: title, Body: reminderBody(t),
			}})
		case t.RemindAt == nil && t.DueAt != nil && inWindow(*t.DueAt, start, now):
			out = append(out, FeedItem{Settled: settled, Notification: Notification{
				TaskID: t.ID, Kind: KindDue, FireAt: t.DueAt.UTC(),
				Title: title, Body: "Due now",
			}})
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
// gone from the OS).
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
		fire := t.RemindAt
		if fire == nil {
			fire = t.DueAt
		}
		if fire == nil {
			continue // never had a notification
		}
		f := fire.UTC()
		if f.After(now) || f.Before(lower) {
			continue // not yet fired, or too old to still be shown
		}
		out = append(out, t.ID)
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
