//go:build !js

package store

import (
	"testing"
	"time"

	"companion/core/domain"
)

// Someday stands in for a start: setting either clears the other, on tasks and projects alike.
func TestSomedayExcludesAStart(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)
	start := time.Date(2026, 10, 1, 13, 0, 0, 0, time.UTC)
	yes := true

	task, err := s.Tasks.Create(CreateTaskInput{Title: "Learn the cello", StartAt: &start, Someday: true})
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	if !task.Someday || task.StartAt != nil {
		t.Errorf("created someday task = someday %v start %v, want someday and no start", task.Someday, task.StartAt)
	}
	task, _ = s.Tasks.Update(task.ID, UpdateTaskInput{StartAt: &start})
	if task.Someday || task.StartAt == nil {
		t.Errorf("after a start: someday %v start %v, want started", task.Someday, task.StartAt)
	}
	task, _ = s.Tasks.Update(task.ID, UpdateTaskInput{Someday: &yes})
	if got, _ := s.Tasks.Get(task.ID); !got.Someday || got.StartAt != nil {
		t.Errorf("after someday: someday %v start %v, want filed away", got.Someday, got.StartAt)
	}

	area, _ := s.Areas.Create(CreateAreaInput{Name: "Life"})
	proj, _ := s.Projects.Create(CreateProjectInput{AreaID: area.ID, Name: "Sabbatical", StartAt: &start})
	proj, err = s.Projects.Update(proj.ID, UpdateProjectInput{Someday: &yes})
	if err != nil || !proj.Someday || proj.StartAt != nil {
		t.Errorf("someday project = %+v (err %v), want someday and no start", proj, err)
	}
	proj, _ = s.Projects.Update(proj.ID, UpdateProjectInput{StartAt: &start})
	if got, _ := s.Projects.Get(proj.ID); got.Someday || got.StartAt == nil || !got.StartAt.Equal(start) {
		t.Errorf("restarted project = someday %v start %v", got.Someday, got.StartAt)
	}
}

// A project's schedule, completion and repeat round-trip through Update, Apply and the diff.
func TestProjectSchedulingFields(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)
	area, _ := s.Areas.Create(CreateAreaInput{Name: "Work"})
	proj, _ := s.Projects.Create(CreateProjectInput{AreaID: area.ID, Name: "Launch"})

	start := time.Date(2026, 10, 1, 13, 0, 0, 0, time.UTC)
	due := start.AddDate(0, 0, 9)
	after, rule := "p2w", "FREQ=WEEKLY"
	got, err := s.Projects.Update(proj.ID, UpdateProjectInput{StartAt: &start, DueAt: &due, RepeatAfter: &after})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if got.RepeatAfter == nil || *got.RepeatAfter != "P2W" {
		t.Errorf("repeatAfter = %v, want canonical P2W", got.RepeatAfter)
	}
	// The two kinds of repeat exclude each other.
	got, _ = s.Projects.Update(proj.ID, UpdateProjectInput{RepeatRule: &rule})
	if got.RepeatAfter != nil || got.RepeatRule == nil {
		t.Errorf("after a schedule: rule %v after %v", got.RepeatRule, got.RepeatAfter)
	}
	bad := "P0D"
	if _, err := s.Projects.Update(proj.ID, UpdateProjectInput{RepeatAfter: &bad}); err == nil {
		t.Error("a zero interval should be rejected")
	}

	// Completing archives too (out of the graph); reopening undoes both.
	yes, no := true, false
	got, _ = s.Projects.Update(proj.ID, UpdateProjectInput{Completed: &yes})
	if got.CompletedAt == nil || got.ArchivedAt == nil {
		t.Errorf("completed = %v archived = %v, want both stamped", got.CompletedAt, got.ArchivedAt)
	}
	sidebar, _ := s.Sidebar()
	if n := len(sidebar.Areas[0].Projects); n != 0 {
		t.Errorf("sidebar lists %d projects, want the completed one hidden", n)
	}

	// A pulled row carries every field, and each one counts as a meaningful difference.
	stored, _ := s.Projects.GetAny(proj.ID)
	remote := *stored
	remote.Version++
	remote.Someday, remote.StartAt = true, nil
	if !s.Projects.MeaningfulDiff(stored, &remote) {
		t.Error("someday should be a meaningful diff")
	}
	if err := s.Projects.Apply(&remote); err != nil {
		t.Fatalf("apply: %v", err)
	}
	applied, _ := s.Projects.GetAny(proj.ID)
	if !applied.Someday || applied.StartAt != nil || applied.DueAt == nil || !applied.DueAt.Equal(due) ||
		applied.CompletedAt == nil || applied.RepeatRule == nil || *applied.RepeatRule != rule {
		t.Errorf("applied = %+v", applied)
	}

	got, _ = s.Projects.Update(proj.ID, UpdateProjectInput{Completed: &no, ClearRepeat: true, ClearDueAt: true})
	if got.CompletedAt != nil || got.ArchivedAt != nil || got.Repeats() || got.DueAt != nil {
		t.Errorf("reopened = %+v, want open with no repeat or deadline", got)
	}
	sidebar, _ = s.Sidebar()
	if ps := sidebar.Areas[0].Projects; len(ps) != 1 || !ps[0].Someday {
		t.Errorf("sidebar projects = %+v, want the reopened someday project", ps)
	}
}

// An open task or project with both a start and a deadline spans its days; anything else with a
// deadline is a point on it.
func TestCalendarRangeSpans(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)
	day := func(d, h int) *time.Time {
		at := time.Date(2026, 10, d, h, 0, 0, 0, time.UTC)
		return &at
	}
	area, _ := s.Areas.Create(CreateAreaInput{Name: "Work"})
	launch, _ := s.Projects.Create(CreateProjectInput{AreaID: area.ID, Name: "Launch", StartAt: day(1, 9), DueAt: day(9, 17)})
	s.Projects.Create(CreateProjectInput{AreaID: area.ID, Name: "No deadline", StartAt: day(1, 9)})
	finished, _ := s.Projects.Create(CreateProjectInput{AreaID: area.ID, Name: "Finished", StartAt: day(1, 9), DueAt: day(9, 17)})
	yes := true
	s.Projects.Update(finished.ID, UpdateProjectInput{Completed: &yes})

	s.Tasks.Create(CreateTaskInput{Title: "Draft", StartAt: day(4, 9), DueAt: day(6, 17)})
	s.Tasks.Create(CreateTaskInput{Title: "Point", DueAt: day(5, 15)})
	s.Tasks.Create(CreateTaskInput{Title: "Done span", StartAt: day(4, 9), DueAt: day(5, 16), Status: domain.TaskDone})
	s.Tasks.Create(CreateTaskInput{Title: "Later", StartAt: day(7, 9), DueAt: day(8, 17)})

	items, err := s.CalendarEvents.Range(*day(5, 0), *day(6, 0))
	if err != nil {
		t.Fatalf("range: %v", err)
	}
	got := map[string]*domain.CalendarItem{}
	for _, it := range items {
		got[it.Title] = it
	}
	if len(got) != 4 {
		t.Fatalf("items on the 5th = %v, want Launch, Draft, Point and Done span", got)
	}
	if it := got["Launch"]; it == nil || it.Kind != domain.ItemProject || !it.Span || it.SourceID != launch.ID ||
		!it.StartsAt.Equal(*day(1, 9)) || it.EndsAt == nil || !it.EndsAt.Equal(*day(9, 17)) {
		t.Errorf("Launch = %+v, want a project span from the 1st to the 9th", it)
	}
	if it := got["Draft"]; it == nil || it.Kind != domain.ItemTask || !it.Span || it.EndsAt == nil {
		t.Errorf("Draft = %+v, want a task span", it)
	}
	for _, title := range []string{"Point", "Done span"} {
		if it := got[title]; it == nil || it.Span || it.EndsAt != nil {
			t.Errorf("%s = %+v, want a point on its deadline", title, it)
		}
	}

	// A project's own calendar shows the project itself.
	items, _ = s.CalendarEvents.RangeForProject(*day(5, 0), *day(6, 0), launch.ID)
	if len(items) != 1 || items[0].SourceID != launch.ID {
		t.Errorf("project calendar = %+v, want just the project's span", items)
	}
}
