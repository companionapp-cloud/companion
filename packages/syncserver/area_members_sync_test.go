package syncserver

import (
	"testing"
	"time"

	"companion/core/domain"
	"companion/core/store"
)

// An area's page (icon, cover, description) and the content filed directly in it converge on a
// second device, which mirrors no graph edge for it — an area is not a node (PLAN-areas.md §1, §2).
func TestAreaPageAndMembersSync(t *testing.T) {
	ts := newServer(t)
	token := register(t, ts.URL, "areas@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	icon, cover, desc := "🏡", "doc-cover", "Everything about **home**."
	area, err := a.store.Areas.Create(store.CreateAreaInput{Name: "Home", Icon: &icon, CoverDocumentID: &cover, DescriptionMd: desc})
	if err != nil {
		t.Fatalf("create area: %v", err)
	}
	project, _ := a.store.Projects.Create(store.CreateProjectInput{AreaID: area.ID, Name: "Kitchen", Icon: &icon, DescriptionMd: desc})
	note, _ := a.store.Notes.Create(store.CreateNoteInput{Title: "Paint colours"})
	if _, err := a.store.ProjectMembers.AddToArea(area.ID, domain.NodeNote, note.ID); err != nil {
		t.Fatalf("add to area: %v", err)
	}
	syncBoth(t, a, b)

	gotArea, err := b.store.Areas.Get(area.ID)
	if err != nil || gotArea.Icon == nil || *gotArea.Icon != icon || gotArea.CoverDocumentID == nil || *gotArea.CoverDocumentID != cover || gotArea.DescriptionMd != desc {
		t.Fatalf("B area = %+v (err %v)", gotArea, err)
	}
	gotProj, err := b.store.Projects.Get(project.ID)
	if err != nil || gotProj.Icon == nil || *gotProj.Icon != icon || gotProj.DescriptionMd != desc {
		t.Fatalf("B project = %+v (err %v)", gotProj, err)
	}
	members, err := b.store.ProjectMembers.ListForArea(area.ID)
	if err != nil || len(members) != 1 || members[0].EntityID != note.ID || !members[0].InArea() {
		t.Fatalf("B area members = %+v (err %v)", members, err)
	}
	if hasMemberEdge(t, b, area.ID, note.ID) {
		t.Errorf("B mirrored a graph edge for an area membership")
	}

	// Moving the note into the project on A moves it on B too: one place, and now an edge.
	a.clk.t = base.Add(time.Hour)
	if _, err := a.store.ProjectMembers.Add(project.ID, domain.NodeNote, note.ID); err != nil {
		t.Fatalf("move to project: %v", err)
	}
	syncBoth(t, a, b)
	live, _ := b.store.ProjectMembers.ListForEntity(domain.NodeNote, note.ID)
	if len(live) != 1 || live[0].ProjectID != project.ID || live[0].InArea() {
		t.Fatalf("B memberships after move = %+v, want only the project", live)
	}
	if !hasMemberEdge(t, b, project.ID, note.ID) {
		t.Errorf("B did not derive the member edge after the move")
	}
}

// Two devices file the same note in different projects before they sync. Both settle on the
// membership created first, and the loser's tombstone reaches the server (PLAN-areas.md §2.1).
func TestConcurrentFilingSettlesOnFirst(t *testing.T) {
	ts := newServer(t)
	token := register(t, ts.URL, "race@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	area, _ := a.store.Areas.Create(store.CreateAreaInput{Name: "Work"})
	p1, _ := a.store.Projects.Create(store.CreateProjectInput{AreaID: area.ID, Name: "One"})
	p2, _ := a.store.Projects.Create(store.CreateProjectInput{AreaID: area.ID, Name: "Two"})
	note, _ := a.store.Notes.Create(store.CreateNoteInput{Title: "Contested"})
	syncBoth(t, a, b)

	a.clk.t = base.Add(time.Hour)
	if _, err := a.store.ProjectMembers.Add(p1.ID, domain.NodeNote, note.ID); err != nil {
		t.Fatalf("A files: %v", err)
	}
	b.clk.t = base.Add(2 * time.Hour)
	if _, err := b.store.ProjectMembers.Add(p2.ID, domain.NodeNote, note.ID); err != nil {
		t.Fatalf("B files: %v", err)
	}
	// A pushes; B pushes and pulls A's row (settling); A pulls B's row (settling the same way)
	// and B's tombstone; one more round carries any tombstone A wrote.
	for i := 0; i < 3; i++ {
		syncBoth(t, a, b)
	}
	for name, c := range map[string]*client{"A": a, "B": b} {
		live, err := c.store.ProjectMembers.ListForEntity(domain.NodeNote, note.ID)
		if err != nil || len(live) != 1 || live[0].ProjectID != p1.ID {
			t.Errorf("%s memberships = %+v (err %v), want only project One (filed first)", name, live, err)
		}
		if dirty, _ := c.store.ProjectMembers.Dirty(); len(dirty) != 0 {
			t.Errorf("%s still has %d dirty memberships", name, len(dirty))
		}
	}
}

func syncBoth(t *testing.T, clients ...*client) {
	t.Helper()
	for _, c := range clients {
		if err := c.engine.Sync(); err != nil {
			t.Fatalf("sync: %v", err)
		}
	}
}

// A repeating task filed directly in an area generates occurrences filed in that same area
// (PLAN-areas.md §2): the server copies the container's kind along with its id.
func TestRepeatOccurrenceInheritsArea(t *testing.T) {
	ts, srv := newServerAPI(t)
	t0 := time.Date(2026, 9, 21, 8, 0, 0, 0, time.UTC)
	clk := &testClock{t: t0}
	srv.clock = clk

	token := registerAt(t, srv, clk, ts.URL, "arearepeat@b.co", "password", t0.AddDate(1, 0, 0))
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	area, _ := a.store.Areas.Create(store.CreateAreaInput{Name: "Home"})
	due, remind := t0.Add(time.Hour), t0 // generation is timed to the reminder, which is now
	rule := "FREQ=DAILY"
	seed, err := a.store.Tasks.Create(store.CreateTaskInput{Title: "Water plants", DueAt: &due,
		Reminders: []domain.Reminder{{At: &remind}}, RepeatRule: &rule})
	if err != nil {
		t.Fatalf("create seed: %v", err)
	}
	if _, err := a.store.ProjectMembers.AddToArea(area.ID, domain.NodeTask, seed.ID); err != nil {
		t.Fatalf("add to area: %v", err)
	}
	syncBoth(t, a, b)

	occ := onlyOccurrence(t, b, seed.ID)
	members, _ := b.store.ProjectMembers.ListForEntity(domain.NodeTask, occ.ID)
	if len(members) != 1 || members[0].ProjectID != area.ID || !members[0].InArea() {
		t.Errorf("occurrence memberships = %+v, want the area %s", members, area.ID)
	}
}
