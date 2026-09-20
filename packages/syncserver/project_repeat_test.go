package syncserver

import (
	"testing"
	"time"

	"companion/core/domain"
	"companion/core/store"
)

// liveProjects returns a client's projects by name, failing on a duplicate.
func liveProjects(t *testing.T, c *client, name string) []*domain.Project {
	t.Helper()
	all, err := c.store.Projects.List()
	if err != nil {
		t.Fatalf("list projects: %v", err)
	}
	var out []*domain.Project
	for _, p := range all {
		if p.Name == name {
			out = append(out, p)
		}
	}
	return out
}

// projectTasks returns the live tasks filed in a project, by title.
func projectTasks(t *testing.T, c *client, projectID string) map[string]*domain.Task {
	t.Helper()
	members, err := c.store.ProjectMembers.ListForProject(projectID)
	if err != nil {
		t.Fatalf("list members: %v", err)
	}
	out := map[string]*domain.Task{}
	for _, m := range members {
		if m.EntityType != "task" {
			continue
		}
		task, err := c.store.Tasks.Get(m.EntityID)
		if err != nil {
			t.Fatalf("get task %s: %v", m.EntityID, err)
		}
		out[task.Title] = task
	}
	return out
}

// Completing an after-completion project brings back a fresh copy on the same sync: open, its
// tasks reset, its lists rebuilt, its notes re-filed, the repeat carried on — and the finished
// one left as an ordinary completed project.
func TestProjectRepeatsAfterCompletion(t *testing.T) {
	ts, srv := newServerAPI(t)
	t0 := time.Date(2026, 7, 6, 15, 30, 0, 0, time.UTC)
	clk := &testClock{t: t0}
	srv.clock = clk

	token := registerAt(t, srv, clk, ts.URL, "after@b.co", "password", t0.AddDate(1, 0, 0))
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	area, _ := a.store.Areas.Create(store.CreateAreaInput{Name: "Home"})
	start := time.Date(2026, 7, 1, 9, 0, 0, 0, time.UTC)
	due := start.AddDate(0, 0, 2)
	proj, err := a.store.Projects.Create(store.CreateProjectInput{AreaID: area.ID, Name: "Deep clean", StartAt: &start, DueAt: &due})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	after := "P1W"
	if _, err := a.store.Projects.Update(proj.ID, store.UpdateProjectInput{RepeatAfter: &after}); err != nil {
		t.Fatalf("set repeat: %v", err)
	}
	taskDue := start.AddDate(0, 0, 1)
	done := domain.TaskDone
	kitchen, _ := a.store.Tasks.Create(store.CreateTaskInput{Title: "Kitchen", DueAt: &taskDue})
	bath, _ := a.store.Tasks.Create(store.CreateTaskInput{Title: "Bathroom"})
	dropped, _ := a.store.Tasks.Create(store.CreateTaskInput{Title: "Attic", Status: domain.TaskCancelled})
	note, _ := a.store.Notes.Create(store.CreateNoteInput{Title: "Supplies"})
	for _, id := range []string{kitchen.ID, bath.ID, dropped.ID} {
		if _, err := a.store.ProjectMembers.Add(proj.ID, "task", id); err != nil {
			t.Fatalf("file task: %v", err)
		}
	}
	if _, err := a.store.ProjectMembers.Add(proj.ID, "note", note.ID); err != nil {
		t.Fatalf("file note: %v", err)
	}
	list, _ := a.store.Lists.Create(store.CreateListInput{ProjectID: proj.ID, Name: "Rooms"})
	a.store.ListItems.AddHeading(list.ID, "Downstairs")
	a.store.ListItems.AddTask(list.ID, kitchen.ID)
	a.store.ListItems.AddTask(list.ID, dropped.ID)
	a.engine.Sync()

	// Nothing repeats until it is completed.
	if _, err := srv.MaterializeAllRepeats(); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	a.engine.Sync()
	if got := liveProjects(t, a, "Deep clean"); len(got) != 1 {
		t.Fatalf("before completion: %d copies, want 1", len(got))
	}

	a.store.Tasks.Update(kitchen.ID, store.UpdateTaskInput{Status: &done})
	completed := true
	if _, err := a.store.Projects.Update(proj.ID, store.UpdateProjectInput{Completed: &completed}); err != nil {
		t.Fatalf("complete: %v", err)
	}
	a.engine.Sync()
	a.engine.Sync()
	b.engine.Sync()

	copies := liveProjects(t, b, "Deep clean")
	if len(copies) != 2 {
		t.Fatalf("after completion: %d copies, want 2", len(copies))
	}
	var old, next *domain.Project
	for _, p := range copies {
		if p.ID == proj.ID {
			old = p
		} else {
			next = p
		}
	}
	if old == nil || next == nil {
		t.Fatalf("copies = %+v", copies)
	}
	if old.CompletedAt == nil || old.Repeats() {
		t.Errorf("finished copy: completedAt %v, repeats %v — want completed, no repeat", old.CompletedAt, old.Repeats())
	}
	// A week after it was ticked off (by the client's clock), at the old start's 9:00.
	landing := old.CompletedAt.AddDate(0, 0, 7)
	wantStart := time.Date(landing.Year(), landing.Month(), landing.Day(), 9, 0, 0, 0, time.UTC)
	if wantStart.After(landing) {
		wantStart = wantStart.AddDate(0, 0, -1)
	}
	if next.StartAt == nil || !next.StartAt.Equal(wantStart) || next.DueAt == nil || !next.DueAt.Equal(wantStart.AddDate(0, 0, 2)) {
		t.Errorf("next copy dates = %v → %v, want %v → +2d", next.StartAt, next.DueAt, wantStart)
	}
	if next.CompletedAt != nil || next.ArchivedAt != nil || next.RepeatAfter == nil || *next.RepeatAfter != after || next.AreaID != area.ID {
		t.Errorf("next copy = %+v, want open, repeating %s, in the same area", next, after)
	}

	tasks := projectTasks(t, b, next.ID)
	if len(tasks) != 2 || tasks["Kitchen"] == nil || tasks["Bathroom"] == nil {
		t.Fatalf("next copy's tasks = %v, want Kitchen and Bathroom (not the cancelled Attic)", tasks)
	}
	k := tasks["Kitchen"]
	if k.ID == kitchen.ID || k.Status != domain.TaskOpen || k.CompletedAt != nil {
		t.Errorf("copied Kitchen = %+v, want a fresh open task", k)
	}
	if delta := wantStart.Sub(start); k.DueAt == nil || !k.DueAt.Equal(taskDue.Add(delta)) {
		t.Errorf("copied Kitchen due = %v, want %v", k.DueAt, taskDue.Add(delta))
	}
	if orig := projectTasks(t, b, proj.ID); len(orig) != 3 || orig["Kitchen"].Status != domain.TaskDone {
		t.Errorf("finished copy's tasks = %v, want its three, Kitchen done", orig)
	}

	// The note follows the live project.
	where, _ := b.store.ProjectMembers.ListForEntity("note", note.ID)
	if len(where) != 1 || where[0].ProjectID != next.ID {
		t.Errorf("note filed in %+v, want only the next copy %s", where, next.ID)
	}

	// The list is rebuilt: its heading, and Kitchen's copy — not the cancelled task's.
	lists, _ := b.store.Lists.ListForProject(next.ID)
	if len(lists) != 1 || lists[0].Name != "Rooms" {
		t.Fatalf("next copy's lists = %+v, want Rooms", lists)
	}
	items, _ := b.store.ListItems.ListForList(lists[0].ID)
	if len(items) != 2 || items[0].Kind != domain.ListItemHeading || items[0].Title != "Downstairs" ||
		items[1].TaskID == nil || *items[1].TaskID != k.ID {
		t.Errorf("copied list items = %+v, want the heading then Kitchen's copy", items)
	}

	// Another sweep makes nothing more.
	if n, err := srv.MaterializeAllRepeats(); err != nil || n != 0 {
		t.Errorf("second sweep wrote %d rows (err %v), want none", n, err)
	}
}

// A scheduled project gets its next copy at that copy's start — not before, once only — with
// both dates moved on, whether or not the current one was finished.
func TestProjectRepeatsOnSchedule(t *testing.T) {
	ts, srv := newServerAPI(t)
	t0 := time.Date(2026, 7, 6, 9, 0, 0, 0, time.UTC) // a Monday
	clk := &testClock{t: t0}
	srv.clock = clk

	token := registerAt(t, srv, clk, ts.URL, "weekly@b.co", "password", t0.AddDate(1, 0, 0))
	a := newClient(t, ts.URL, token, "devA")

	area, _ := a.store.Areas.Create(store.CreateAreaInput{Name: "Work"})
	due := t0.AddDate(0, 0, 4)
	proj, _ := a.store.Projects.Create(store.CreateProjectInput{AreaID: area.ID, Name: "Weekly review", StartAt: &t0, DueAt: &due})
	rule := "FREQ=WEEKLY;UNTIL=20260721T000000Z"
	if _, err := a.store.Projects.Update(proj.ID, store.UpdateProjectInput{RepeatRule: &rule}); err != nil {
		t.Fatalf("set repeat: %v", err)
	}
	a.engine.Sync()

	clk.t = t0.AddDate(0, 0, 6)
	srv.MaterializeAllRepeats()
	a.engine.Sync()
	if got := liveProjects(t, a, "Weekly review"); len(got) != 1 {
		t.Fatalf("a day early: %d copies, want 1", len(got))
	}

	clk.t = t0.AddDate(0, 0, 7)
	srv.MaterializeAllRepeats()
	srv.MaterializeAllRepeats()
	a.engine.Sync()
	copies := liveProjects(t, a, "Weekly review")
	if len(copies) != 2 {
		t.Fatalf("at its turn: %d copies, want 2", len(copies))
	}
	for _, p := range copies {
		if p.ID == proj.ID {
			if p.Repeats() {
				t.Errorf("the first copy still carries the repeat")
			}
			continue
		}
		if !p.StartAt.Equal(t0.AddDate(0, 0, 7)) || !p.DueAt.Equal(due.AddDate(0, 0, 7)) || p.RepeatRule == nil {
			t.Errorf("second copy = %v → %v (rule %v), want a week on, still repeating", p.StartAt, p.DueAt, p.RepeatRule)
		}
	}

	// The rule ends on the 21st: the third Monday (the 20th) is the last copy.
	clk.t = t0.AddDate(0, 0, 30)
	srv.MaterializeAllRepeats()
	srv.MaterializeAllRepeats()
	a.engine.Sync()
	if got := liveProjects(t, a, "Weekly review"); len(got) != 3 {
		t.Errorf("after the end date: %d copies, want 3", len(got))
	}
}

// A deadline-only project is only useful before its deadline, so its next copy appears as soon
// as the current deadline passes.
func TestProjectRepeatDeadlineOnly(t *testing.T) {
	ts, srv := newServerAPI(t)
	t0 := time.Date(2026, 7, 6, 9, 0, 0, 0, time.UTC)
	clk := &testClock{t: t0}
	srv.clock = clk

	token := registerAt(t, srv, clk, ts.URL, "due@b.co", "password", t0.AddDate(1, 0, 0))
	a := newClient(t, ts.URL, token, "devA")

	area, _ := a.store.Areas.Create(store.CreateAreaInput{Name: "Money"})
	due := t0.AddDate(0, 0, 3)
	proj, _ := a.store.Projects.Create(store.CreateProjectInput{AreaID: area.ID, Name: "Close the books", DueAt: &due})
	rule := "FREQ=MONTHLY"
	a.store.Projects.Update(proj.ID, store.UpdateProjectInput{RepeatRule: &rule})
	a.engine.Sync()
	if got := liveProjects(t, a, "Close the books"); len(got) != 1 {
		t.Fatalf("before the deadline: %d copies, want 1", len(got))
	}

	clk.t = due.Add(time.Minute)
	srv.MaterializeAllRepeats()
	a.engine.Sync()
	copies := liveProjects(t, a, "Close the books")
	if len(copies) != 2 {
		t.Fatalf("after the deadline: %d copies, want 2", len(copies))
	}
	for _, p := range copies {
		if p.ID != proj.ID && (p.StartAt != nil || p.DueAt == nil || !p.DueAt.Equal(due.AddDate(0, 1, 0))) {
			t.Errorf("next copy = %v → %v, want only a deadline a month on", p.StartAt, p.DueAt)
		}
	}
}
