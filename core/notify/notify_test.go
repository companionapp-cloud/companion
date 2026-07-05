package notify

import (
	"testing"
	"time"

	"companion/core/domain"
)

func TestPlanTasks(t *testing.T) {
	now := time.Date(2026, 7, 5, 12, 0, 0, 0, time.UTC)
	at := func(d time.Duration) *time.Time { v := now.Add(d); return &v }

	tasks := []*domain.Task{
		{ID: "reminder-soon", Title: "Call bank", Status: domain.TaskOpen, RemindAt: at(2 * time.Hour)},
		{ID: "reminder-far", Title: "Far", Status: domain.TaskOpen, RemindAt: at(72 * time.Hour)},        // beyond horizon
		{ID: "reminder-past", Title: "Past", Status: domain.TaskOpen, RemindAt: at(-time.Hour)},          // already past
		{ID: "done", Title: "Done", Status: domain.TaskDone, RemindAt: at(time.Hour)},                    // completed
		{ID: "trashed", Title: "Trashed", Status: domain.TaskOpen, RemindAt: at(time.Hour), DeletingAt: at(0)},
		{ID: "due-only", Title: "Ship it", Status: domain.TaskOpen, DueAt: at(3 * time.Hour)},            // due, no reminder
		{ID: "no-time", Title: "Someday", Status: domain.TaskOpen},                                       // nothing to fire
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
