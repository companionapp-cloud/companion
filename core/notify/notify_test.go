package notify

import (
	"testing"
	"time"

	"companion/core/domain"
)

// remind builds a single absolute reminder, the shape every task had before reminder lists.
func remind(at *time.Time) []domain.Reminder { return []domain.Reminder{{At: at}} }

func TestPlanTasksMultipleReminders(t *testing.T) {
	now := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	deadline := time.Date(2026, 10, 10, 21, 0, 0, 0, time.UTC)
	extra := time.Date(2026, 10, 2, 13, 0, 0, 0, time.UTC)
	task := &domain.Task{ID: "report", Title: "Quarterly report", Status: domain.TaskOpen, DueAt: &deadline,
		Reminders: []domain.Reminder{
			{Before: "P1M"},  // Sep 10: already past, never planned
			{Before: "P1W"},  // Oct 3
			{Before: "P3D"},  // Oct 7
			{Before: "P1D"},  // Oct 9
			{Before: "PT0M"}, // at the deadline
			{At: &extra},     // Oct 2, absolute
		}}

	got := PlanTasks([]*domain.Task{task}, now, 30*24*time.Hour)
	want := []time.Time{
		extra,
		time.Date(2026, 10, 3, 21, 0, 0, 0, time.UTC),
		time.Date(2026, 10, 7, 21, 0, 0, 0, time.UTC),
		time.Date(2026, 10, 9, 21, 0, 0, 0, time.UTC),
		deadline,
	}
	if len(got) != len(want) {
		t.Fatalf("plan has %d fires, want %d: %+v", len(got), len(want), got)
	}
	for i, n := range got {
		if !n.FireAt.Equal(want[i]) || n.Kind != KindReminder || n.TaskID != "report" {
			t.Errorf("fire %d = %+v, want a reminder at %v", i, n, want[i])
		}
	}
	// Only the reminder that lands on the deadline reads "Due now"; the others name it.
	if got[4].Body != "Due now" || got[0].Body == "Due now" {
		t.Errorf("bodies = %q / %q", got[0].Body, got[4].Body)
	}

	// Reminders replace the implicit deadline fire: the deadline fires only via "PT0M" above.
	noDeadlineFire := &domain.Task{ID: "early", Status: domain.TaskOpen, DueAt: &deadline,
		Reminders: []domain.Reminder{{Before: "P1D"}}}
	if plan := PlanTasks([]*domain.Task{noDeadlineFire}, now, 30*24*time.Hour); len(plan) != 1 || plan[0].Kind != KindReminder {
		t.Errorf("a task with reminders should not also fire at its deadline: %+v", plan)
	}

	// Relative reminders are inert without a deadline.
	undated := &domain.Task{ID: "undated", Status: domain.TaskOpen, Reminders: []domain.Reminder{{Before: "P1D"}}}
	if plan := PlanTasks([]*domain.Task{undated}, now, 30*24*time.Hour); len(plan) != 0 {
		t.Errorf("relative reminders without a deadline should not fire: %+v", plan)
	}

	// A settled task with several past fires is dismissed once.
	done := &domain.Task{ID: "done", Status: domain.TaskDone, DueAt: &deadline,
		Reminders: []domain.Reminder{{Before: "P1D"}, {Before: "PT0M"}}}
	after := deadline.Add(time.Hour)
	if ids := SettledReminderIDs([]*domain.Task{done}, after, 48*time.Hour); len(ids) != 1 || ids[0] != "done" {
		t.Errorf("SettledReminderIDs = %v, want [done]", ids)
	}
	if feed := FeedTasks([]*domain.Task{done}, after, 48*time.Hour); len(feed) != 2 || !feed[0].FireAt.Equal(deadline) {
		t.Errorf("feed should list both past fires, newest first: %+v", feed)
	}
}

func TestPlanTasks(t *testing.T) {
	now := time.Date(2026, 7, 5, 12, 0, 0, 0, time.UTC)
	at := func(d time.Duration) *time.Time { v := now.Add(d); return &v }

	tasks := []*domain.Task{
		{ID: "reminder-soon", Title: "Call bank", Status: domain.TaskOpen, Reminders: remind(at(2 * time.Hour))},
		{ID: "reminder-far", Title: "Far", Status: domain.TaskOpen, Reminders: remind(at(72 * time.Hour))}, // beyond horizon
		{ID: "reminder-past", Title: "Past", Status: domain.TaskOpen, Reminders: remind(at(-time.Hour))},   // already past
		{ID: "done", Title: "Done", Status: domain.TaskDone, Reminders: remind(at(time.Hour))},             // completed
		{ID: "trashed", Title: "Trashed", Status: domain.TaskOpen, Reminders: remind(at(time.Hour)), DeletingAt: at(0)},
		{ID: "due-only", Title: "Ship it", Status: domain.TaskOpen, DueAt: at(3 * time.Hour)}, // due, no reminder
		{ID: "no-time", Title: "Someday", Status: domain.TaskOpen},                            // nothing to fire
	}

	got := PlanTasks(tasks, now, 24*time.Hour)
	if len(got) != 2 {
		t.Fatalf("plan has %d notifications, want 2: %+v", len(got), got)
	}
	// Sorted by fire time: reminder-soon (t+2h) before due-only (t+3h).
	if got[0].TaskID != "reminder-soon" || got[0].Kind != KindReminder {
		t.Errorf("first = %+v, want reminder-soon reminder", got[0])
	}
	if got[1].TaskID != "due-only" || got[1].Kind != KindDue {
		t.Errorf("second = %+v, want due-only due", got[1])
	}
}

func TestFeedTasks(t *testing.T) {
	now := time.Date(2026, 7, 5, 12, 0, 0, 0, time.UTC)
	at := func(d time.Duration) *time.Time { v := now.Add(d); return &v }

	tasks := []*domain.Task{
		{ID: "fired-recent", Title: "Call bank", Status: domain.TaskOpen, Reminders: remind(at(-2 * time.Hour))},
		{ID: "fired-older", Title: "Water plants", Status: domain.TaskOpen, Reminders: remind(at(-48 * time.Hour))},
		{ID: "fired-done", Title: "Done", Status: domain.TaskDone, Reminders: remind(at(-time.Hour))},          // settled: kept, flagged
		{ID: "fired-stale", Title: "Stale", Status: domain.TaskOpen, Reminders: remind(at(-15 * 24 * time.Hour))}, // beyond lookback
		{ID: "upcoming", Title: "Future", Status: domain.TaskOpen, Reminders: remind(at(time.Hour))},           // hasn't fired
		{ID: "trashed", Title: "Trashed", Status: domain.TaskOpen, Reminders: remind(at(-time.Hour)), DeletingAt: at(0)},
		{ID: "due-fired", Title: "Ship it", Status: domain.TaskOpen, DueAt: at(-3 * time.Hour)}, // due, no reminder
		{ID: "no-time", Title: "Someday", Status: domain.TaskOpen},
	}

	got := FeedTasks(tasks, now, 14*24*time.Hour)
	wantOrder := []string{"fired-done", "fired-recent", "due-fired", "fired-older"} // newest first
	if len(got) != len(wantOrder) {
		t.Fatalf("feed has %d items, want %d: %+v", len(got), len(wantOrder), got)
	}
	for i, id := range wantOrder {
		if got[i].TaskID != id {
			t.Errorf("feed[%d] = %q, want %q (feed %+v)", i, got[i].TaskID, id, got)
		}
	}
	for _, item := range got {
		wantSettled := item.TaskID == "fired-done"
		if item.Settled != wantSettled {
			t.Errorf("%s settled = %v, want %v", item.TaskID, item.Settled, wantSettled)
		}
	}
	if got[2].Kind != KindDue {
		t.Errorf("due-fired kind = %q, want %q", got[2].Kind, KindDue)
	}
}

func TestSettledReminderIDs(t *testing.T) {
	now := time.Date(2026, 7, 5, 12, 0, 0, 0, time.UTC)
	at := func(d time.Duration) *time.Time { v := now.Add(d); return &v }

	tasks := []*domain.Task{
		// Done, reminder fired an hour ago → dismiss its lingering banner.
		{ID: "done-fired", Status: domain.TaskDone, Reminders: remind(at(-time.Hour))},
		// Cancelled, due-based fire in the recent past → dismiss.
		{ID: "cancelled-fired", Status: domain.TaskCancelled, DueAt: at(-2 * time.Hour)},
		// Done but the reminder hasn't fired yet (future) → nothing was ever shown.
		{ID: "done-pending", Status: domain.TaskDone, Reminders: remind(at(time.Hour))},
		// Still open, reminder fired → keep it (user hasn't finished the task).
		{ID: "open-fired", Status: domain.TaskOpen, Reminders: remind(at(-time.Hour))},
		// Done long ago → too old to still be shown.
		{ID: "done-stale", Status: domain.TaskDone, Reminders: remind(at(-72 * time.Hour))},
		// Done with no reminder/due → never had a notification.
		{ID: "done-notime", Status: domain.TaskDone},
	}

	got := SettledReminderIDs(tasks, now, 24*time.Hour)
	want := map[string]bool{"done-fired": true, "cancelled-fired": true}
	if len(got) != len(want) {
		t.Fatalf("got %v, want keys %v", got, want)
	}
	for _, id := range got {
		if !want[id] {
			t.Errorf("unexpected dismiss id %q (got %v)", id, got)
		}
	}
}
