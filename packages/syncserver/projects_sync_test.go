package syncserver

import (
	"testing"
	"time"

	"companion/core/domain"
	"companion/core/store"
)

// Areas, projects, and memberships created on device A converge on device B, and B
// derives the same authored `member` edge locally — proving the generalized
// multi-entity sync path plus edge mirroring on sync-apply (PLAN §5.1, §7).
func TestAreasProjectsMembersSync(t *testing.T) {
	ts := newServer(t)
	token := register(t, ts.URL, "p@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	area, err := a.store.Areas.Create(store.CreateAreaInput{Name: "Work"})
	if err != nil {
		t.Fatalf("create area: %v", err)
	}
	project, err := a.store.Projects.Create(store.CreateProjectInput{AreaID: area.ID, Name: "Q3 Launch"})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	note, err := a.store.Notes.Create(store.CreateNoteInput{Title: "Spec"})
	if err != nil {
		t.Fatalf("create note: %v", err)
	}
	if _, err := a.store.ProjectMembers.Add(project.ID, domain.NodeNote, note.ID); err != nil {
		t.Fatalf("add member: %v", err)
	}

	if err := a.engine.Sync(); err != nil {
		t.Fatalf("A sync: %v", err)
	}
	if err := b.engine.Sync(); err != nil {
		t.Fatalf("B sync: %v", err)
	}

	// B has the area and project.
	if got, err := b.store.Areas.Get(area.ID); err != nil || got.Name != "Work" {
		t.Fatalf("B area = %+v (err %v)", got, err)
	}
	gotProj, err := b.store.Projects.Get(project.ID)
	if err != nil || gotProj.Name != "Q3 Launch" || gotProj.AreaID != area.ID {
		t.Fatalf("B project = %+v (err %v)", gotProj, err)
	}
	if gotProj.Dirty || gotProj.Version == 0 {
		t.Errorf("synced project should be clean with a server version: %+v", gotProj)
	}

	// B has the membership...
	members, err := b.store.ProjectMembers.ListForEntity(domain.NodeNote, note.ID)
	if err != nil || len(members) != 1 || members[0].ProjectID != project.ID {
		t.Fatalf("B memberships = %+v (err %v)", members, err)
	}
	// ...and derived the same `member` edge into its local link index.
	if !hasMemberEdge(t, b, project.ID, note.ID) {
		t.Errorf("B did not derive the member edge project=%s -> note=%s", project.ID, note.ID)
	}

	// Removing the membership on A tombstones it and drops the edge on B.
	a.clk.t = base.Add(time.Hour)
	if err := a.store.ProjectMembers.Remove(project.ID, domain.NodeNote, note.ID); err != nil {
		t.Fatalf("remove member: %v", err)
	}
	if err := a.engine.Sync(); err != nil {
		t.Fatalf("A sync 2: %v", err)
	}
	if err := b.engine.Sync(); err != nil {
		t.Fatalf("B sync 2: %v", err)
	}
	if members, _ := b.store.ProjectMembers.ListForEntity(domain.NodeNote, note.ID); len(members) != 0 {
		t.Errorf("B should have no live memberships after removal, got %d", len(members))
	}
	if hasMemberEdge(t, b, project.ID, note.ID) {
		t.Errorf("B should have dropped the member edge after removal")
	}
}

func hasMemberEdge(t *testing.T, c *client, projectID, targetID string) bool {
	t.Helper()
	g, err := c.store.Links.Full()
	if err != nil {
		t.Fatalf("graph full: %v", err)
	}
	for _, e := range g.Edges {
		if e.Kind == domain.KindMember && e.SourceID == projectID && e.TargetID == targetID {
			return true
		}
	}
	return false
}
