package syncserver

import (
	"testing"
	"time"

	"companion/core/domain"
	"companion/core/store"
)

// A list, its heading, and its ordered task items created on device A converge on device B
// with the same order; a reorder and a removal on A propagate too.
func TestListsSync(t *testing.T) {
	ts := newServer(t)
	token := register(t, ts.URL, "l@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	area, _ := a.store.Areas.Create(store.CreateAreaInput{Name: "Work"})
	project, _ := a.store.Projects.Create(store.CreateProjectInput{AreaID: area.ID, Name: "Launch"})
	list, err := a.store.Lists.Create(store.CreateListInput{ProjectID: project.ID, Name: "Now"})
	if err != nil {
		t.Fatalf("create list: %v", err)
	}
	t1, _ := a.store.Tasks.Create(store.CreateTaskInput{Title: "One"})
	t2, _ := a.store.Tasks.Create(store.CreateTaskInput{Title: "Two"})
	heading, _ := a.store.ListItems.AddHeading(list.ID, "Blocked")
	i1, _ := a.store.ListItems.AddTask(list.ID, t1.ID)
	i2, _ := a.store.ListItems.AddTask(list.ID, t2.ID)

	if err := a.engine.Sync(); err != nil {
		t.Fatalf("A sync: %v", err)
	}
	if err := b.engine.Sync(); err != nil {
		t.Fatalf("B sync: %v", err)
	}

	got, err := b.store.Lists.Get(list.ID)
	if err != nil || got.Name != "Now" || got.ProjectID != project.ID {
		t.Fatalf("B list = %+v (err %v)", got, err)
	}
	if got.Dirty || got.Version == 0 {
		t.Errorf("synced list should be clean with a server version: %+v", got)
	}
	items, _ := b.store.ListItems.ListForList(list.ID)
	if len(items) != 3 || items[0].ID != heading.ID || items[1].ID != i1.ID || items[2].ID != i2.ID {
		t.Fatalf("B items = %+v", items)
	}
	if items[0].Title != "Blocked" || items[1].TaskID == nil || *items[1].TaskID != t1.ID {
		t.Fatalf("B item content wrong: %+v", items)
	}

	// Reorder + remove on A.
	a.clk.t = base.Add(time.Hour)
	if err := a.store.ListItems.Reorder(list.ID, []string{i2.ID, heading.ID, i1.ID}); err != nil {
		t.Fatalf("reorder: %v", err)
	}
	if err := a.store.ListItems.Remove(i1.ID); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if err := a.engine.Sync(); err != nil {
		t.Fatalf("A sync 2: %v", err)
	}
	if err := b.engine.Sync(); err != nil {
		t.Fatalf("B sync 2: %v", err)
	}
	items, _ = b.store.ListItems.ListForList(list.ID)
	if len(items) != 2 || items[0].ID != i2.ID || items[1].Kind != domain.ListItemHeading {
		t.Fatalf("B items after reorder/remove = %+v", items)
	}

	// The same task added on B independently converges to A's row, not a duplicate.
	if _, err := b.store.ListItems.AddTask(list.ID, t2.ID); err != nil {
		t.Fatalf("B add existing task: %v", err)
	}
	if items, _ = b.store.ListItems.ListForList(list.ID); len(items) != 2 {
		t.Fatalf("duplicate add should not create a row: %d items", len(items))
	}
}
