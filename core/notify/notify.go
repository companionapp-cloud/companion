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
