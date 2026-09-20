//go:build !js

package store

import (
	"testing"
	"time"

	"companion/core/domain"
)

// An area's page fields round-trip, and an empty icon/cover clears it (PLAN-areas.md §1).
func TestAreaAndProjectPageFields(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 20, 9, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	area, err := s.Areas.Create(CreateAreaInput{Name: "Health"})
	if err != nil {
		t.Fatalf("create area: %v", err)
	}
	icon, cover, desc := "🌱", "doc-1", "Stay **well**. See [[note:abc]]."
	if _, err := s.Areas.Update(area.ID, UpdateAreaInput{Icon: &icon, CoverDocumentID: &cover, DescriptionMd: &desc}); err != nil {
		t.Fatalf("update area: %v", err)
	}
	got, _ := s.Areas.Get(area.ID)
	if derefStr(got.Icon) != icon || derefStr(got.CoverDocumentID) != cover || got.DescriptionMd != desc {
		t.Fatalf("area page fields = %q %q %q", derefStr(got.Icon), derefStr(got.CoverDocumentID), got.DescriptionMd)
	}
	// A rename leaves the page alone; an empty icon clears it.
	name, empty := "Wellbeing", ""
	if _, err := s.Areas.Update(area.ID, UpdateAreaInput{Name: &name, Icon: &empty}); err != nil {
		t.Fatalf("clear icon: %v", err)
	}
	got, _ = s.Areas.Get(area.ID)
	if got.Icon != nil || derefStr(got.CoverDocumentID) != cover || got.DescriptionMd != desc || got.Name != name {
		t.Fatalf("after clear: icon=%v cover=%q desc=%q name=%q", got.Icon, derefStr(got.CoverDocumentID), got.DescriptionMd, got.Name)
	}

	proj, _ := s.Projects.Create(CreateProjectInput{AreaID: area.ID, Name: "Run a 10k", Icon: &icon})
	if _, err := s.Projects.Update(proj.ID, UpdateProjectInput{CoverDocumentID: &cover, DescriptionMd: &desc}); err != nil {
		t.Fatalf("update project: %v", err)
	}
	p, _ := s.Projects.Get(proj.ID)
	if derefStr(p.Icon) != icon || derefStr(p.CoverDocumentID) != cover || p.DescriptionMd != desc {
		t.Fatalf("project page fields = %q %q %q", derefStr(p.Icon), derefStr(p.CoverDocumentID), p.DescriptionMd)
	}
	sidebar, _ := s.Sidebar()
	if derefStr(sidebar.Areas[0].Projects[0].Icon) != icon {
		t.Errorf("sidebar project icon = %q, want %q", derefStr(sidebar.Areas[0].Projects[0].Icon), icon)
	}
}

// An area holds notes, tasks and canvases directly — nothing else (PLAN-areas.md §2).
func TestAreaHoldsContentDirectly(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 20, 9, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)
	area, _ := s.Areas.Create(CreateAreaInput{Name: "Work"})
	proj, _ := s.Projects.Create(CreateProjectInput{AreaID: area.ID, Name: "Launch"})
	note, _ := s.Notes.Create(CreateNoteInput{Title: "Area note"})
	inProj, _ := s.Notes.Create(CreateNoteInput{Title: "Project note"})

	m, err := s.ProjectMembers.AddToArea(area.ID, domain.NodeNote, note.ID)
	if err != nil {
		t.Fatalf("add to area: %v", err)
	}
	if !m.InArea() || m.ProjectID != area.ID {
		t.Fatalf("member = %+v, want an area row holding the area id", m)
	}
	if _, err := s.ProjectMembers.Add(proj.ID, domain.NodeNote, inProj.ID); err != nil {
		t.Fatalf("add to project: %v", err)
	}
	if _, err := s.ProjectMembers.AddToArea(area.ID, domain.MemberCalendar, "cal-1"); err == nil {
		t.Error("an area accepted a calendar")
	}

	direct, _ := s.ProjectMembers.ListForArea(area.ID)
	if len(direct) != 1 || direct[0].EntityID != note.ID {
		t.Fatalf("direct members = %+v, want just the area note", direct)
	}
	tree, _ := s.ProjectMembers.ListForAreaTree(area.ID)
	if len(tree) != 2 {
		t.Fatalf("tree members = %d, want the area note and the project note", len(tree))
	}
	// Filed in an area counts as sorted.
	if ids, _ := s.ProjectMembers.MemberEntityIDs(domain.NodeNote); len(ids) != 2 {
		t.Errorf("sorted note ids = %v, want both", ids)
	}
	// An area is not a graph node, so its membership mirrors no edge; the project's does.
	graph, _ := s.Links.Full()
	members := 0
	for _, e := range graph.Edges {
		if e.Kind == domain.KindMember {
			members++
			if e.SourceID == area.ID {
				t.Errorf("area membership leaked into the graph: %+v", e)
			}
		}
	}
	if members != 1 {
		t.Errorf("member edges = %d, want 1 (the project's)", members)
	}
	if _, _, err := s.Links.Rebuild(); err != nil {
		t.Fatalf("rebuild: %v", err)
	}
	graph, _ = s.Links.Full()
	for _, e := range graph.Edges {
		if e.Kind == domain.KindMember && e.SourceID == area.ID {
			t.Errorf("rebuild mirrored an area membership: %+v", e)
		}
	}
}

// Filing content somewhere MOVES it: one live membership, and a task leaving a project leaves
// that project's lists (PLAN-areas.md §2.1).
func TestFilingMovesContent(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 20, 9, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)
	area, _ := s.Areas.Create(CreateAreaInput{Name: "Work"})
	a, _ := s.Projects.Create(CreateProjectInput{AreaID: area.ID, Name: "A"})
	b, _ := s.Projects.Create(CreateProjectInput{AreaID: area.ID, Name: "B"})
	task, _ := s.Tasks.Create(CreateTaskInput{Title: "Ship it"})

	if _, err := s.ProjectMembers.Add(a.ID, domain.NodeTask, task.ID); err != nil {
		t.Fatalf("add to A: %v", err)
	}
	list, _ := s.Lists.Create(CreateListInput{ProjectID: a.ID, Name: "Next"})
	if _, err := s.ListItems.AddTask(list.ID, task.ID); err != nil {
		t.Fatalf("add to list: %v", err)
	}

	moved, err := s.ProjectMembers.Add(b.ID, domain.NodeTask, task.ID)
	if err != nil {
		t.Fatalf("move to B: %v", err)
	}
	live, _ := s.ProjectMembers.ListForEntity(domain.NodeTask, task.ID)
	if len(live) != 1 || live[0].ProjectID != b.ID {
		t.Fatalf("live memberships = %+v, want only B", live)
	}
	if items, _ := s.ListItems.ListForList(list.ID); len(items) != 0 {
		t.Errorf("task still in A's list after leaving A: %+v", items)
	}
	// The tombstone pushes ahead of the new row, so no device sees the task filed twice.
	dirty, _ := s.ProjectMembers.Dirty()
	if len(dirty) != 2 || dirty[0].DeletedAt == nil || dirty[1].ID != moved.ID {
		t.Fatalf("dirty order = %+v, want the tombstone then the new membership", dirty)
	}

	// Project → area → back to the first project (a revived tombstone).
	if _, err := s.ProjectMembers.AddToArea(area.ID, domain.NodeTask, task.ID); err != nil {
		t.Fatalf("move to area: %v", err)
	}
	if _, err := s.ProjectMembers.Add(a.ID, domain.NodeTask, task.ID); err != nil {
		t.Fatalf("move back to A: %v", err)
	}
	live, _ = s.ProjectMembers.ListForEntity(domain.NodeTask, task.ID)
	if len(live) != 1 || live[0].ProjectID != a.ID || live[0].InArea() {
		t.Fatalf("live memberships = %+v, want only A", live)
	}

	// A calendar is not content: it can sit in several projects.
	for _, p := range []string{a.ID, b.ID} {
		if _, err := s.ProjectMembers.Add(p, domain.MemberCalendar, "cal-1"); err != nil {
			t.Fatalf("add calendar: %v", err)
		}
	}
	if cals, _ := s.ProjectMembers.ListForEntity(domain.MemberCalendar, "cal-1"); len(cals) != 2 {
		t.Errorf("calendar memberships = %d, want 2", len(cals))
	}
}

// EnforceSingleContainer is the migration off the many-projects model: content keeps the FIRST
// project it was filed in and leaves the rest; calendars are left alone.
func TestEnforceSingleContainerKeepsFirst(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 20, 9, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)
	area, _ := s.Areas.Create(CreateAreaInput{Name: "Work"})
	first, _ := s.Projects.Create(CreateProjectInput{AreaID: area.ID, Name: "First"})
	second, _ := s.Projects.Create(CreateProjectInput{AreaID: area.ID, Name: "Second"})
	third, _ := s.Projects.Create(CreateProjectInput{AreaID: area.ID, Name: "Third"})
	note, _ := s.Notes.Create(CreateNoteInput{Title: "Everywhere"})
	task, _ := s.Tasks.Create(CreateTaskInput{Title: "Twice"})

	// Rows as the old model (and an older client) wrote them: several live per entity, no
	// container type. Inserted out of order so "first" means created_at, not insertion.
	legacy := func(projectID, entityType, entityID string, at time.Time) {
		t.Helper()
		ts := at.Format(timeFormat)
		if _, err := s.db.Exec(
			`INSERT INTO project_members (id, project_id, entity_type, entity_id, created_at, updated_at, version, dirty)
			 VALUES (?, ?, ?, ?, ?, ?, 1, 0);`,
			memberID(projectID, entityType, entityID), projectID, entityType, entityID, ts, ts); err != nil {
			t.Fatalf("insert legacy member: %v", err)
		}
		if err := s.Links.AddEdge(domain.NodeProject, projectID, entityType, entityID, domain.KindMember); err != nil {
			t.Fatalf("mirror edge: %v", err)
		}
	}
	t0 := clk.t.Add(-time.Hour)
	legacy(third.ID, domain.NodeNote, note.ID, t0.Add(2*time.Minute))
	legacy(first.ID, domain.NodeNote, note.ID, t0)
	legacy(second.ID, domain.NodeNote, note.ID, t0.Add(time.Minute))
	legacy(second.ID, domain.NodeTask, task.ID, t0)
	legacy(first.ID, domain.NodeTask, task.ID, t0.Add(time.Minute))
	legacy(first.ID, domain.MemberCalendar, "cal-1", t0)
	legacy(second.ID, domain.MemberCalendar, "cal-1", t0.Add(time.Minute))

	removed, err := s.ProjectMembers.EnforceSingleContainer()
	if err != nil {
		t.Fatalf("enforce: %v", err)
	}
	if removed != 3 {
		t.Fatalf("removed = %d, want 3 (two note copies, one task copy)", removed)
	}
	if live, _ := s.ProjectMembers.ListForEntity(domain.NodeNote, note.ID); len(live) != 1 || live[0].ProjectID != first.ID {
		t.Errorf("note lives in %+v, want only First", live)
	}
	if live, _ := s.ProjectMembers.ListForEntity(domain.NodeTask, task.ID); len(live) != 1 || live[0].ProjectID != second.ID {
		t.Errorf("task lives in %+v, want only Second (its first)", live)
	}
	if cals, _ := s.ProjectMembers.ListForEntity(domain.MemberCalendar, "cal-1"); len(cals) != 2 {
		t.Errorf("calendar memberships = %d, want both kept", len(cals))
	}
	// The losers are dirty tombstones (they sync), and their graph edges are gone.
	dirty, _ := s.ProjectMembers.Dirty()
	if len(dirty) != 3 {
		t.Errorf("dirty tombstones = %d, want 3", len(dirty))
	}
	graph, _ := s.Links.Full()
	edges := 0
	for _, e := range graph.Edges {
		if e.Kind == domain.KindMember && e.TargetID == note.ID {
			edges++
		}
	}
	if edges != 1 {
		t.Errorf("note member edges = %d, want 1", edges)
	}
	// Settled: a second pass finds nothing.
	if again, _ := s.ProjectMembers.EnforceSingleContainer(); again != 0 {
		t.Errorf("second pass removed %d, want 0", again)
	}
}
