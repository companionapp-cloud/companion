//go:build !js

package store

import (
	"testing"

	"companion/core/domain"
)

func newListFixture(t *testing.T) (*Store, string) {
	t.Helper()
	s := newTestStore(t, nil)
	area, err := s.Areas.Create(CreateAreaInput{Name: "Work"})
	if err != nil {
		t.Fatalf("create area: %v", err)
	}
	project, err := s.Projects.Create(CreateProjectInput{AreaID: area.ID, Name: "Launch"})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	return s, project.ID
}

func TestListsCreateAppendsAndReorders(t *testing.T) {
	s, projectID := newListFixture(t)
	a, err := s.Lists.Create(CreateListInput{ProjectID: projectID, Name: "Now"})
	if err != nil {
		t.Fatalf("create list: %v", err)
	}
	b, _ := s.Lists.Create(CreateListInput{ProjectID: projectID, Name: "Later"})
	if a.SortOrder != 0 || b.SortOrder != 1 {
		t.Fatalf("orders = %d,%d; want 0,1", a.SortOrder, b.SortOrder)
	}
	if err := s.Lists.Reorder(projectID, []string{b.ID, a.ID}); err != nil {
		t.Fatalf("reorder: %v", err)
	}
	lists, _ := s.Lists.ListForProject(projectID)
	if len(lists) != 2 || lists[0].ID != b.ID || lists[1].ID != a.ID {
		t.Fatalf("order after reorder = %v", lists)
	}
	if !lists[0].Dirty {
		t.Error("reordered list should be dirty so the order syncs")
	}
	if _, err := s.Lists.Create(CreateListInput{ProjectID: projectID, Name: "  "}); err == nil {
		t.Error("blank name should fail validation")
	}
}

func TestListItemsTasksAndHeadingsShareOneOrder(t *testing.T) {
	s, projectID := newListFixture(t)
	l, _ := s.Lists.Create(CreateListInput{ProjectID: projectID, Name: "Now"})
	t1, _ := s.Tasks.Create(CreateTaskInput{Title: "One"})
	t2, _ := s.Tasks.Create(CreateTaskInput{Title: "Two"})

	i1, err := s.ListItems.AddTask(l.ID, t1.ID)
	if err != nil {
		t.Fatalf("add task: %v", err)
	}
	h, err := s.ListItems.AddHeading(l.ID, "Blocked")
	if err != nil {
		t.Fatalf("add heading: %v", err)
	}
	i2, _ := s.ListItems.AddTask(l.ID, t2.ID)

	// Adding the same task twice is idempotent and returns the same deterministic row.
	again, _ := s.ListItems.AddTask(l.ID, t1.ID)
	if again.ID != i1.ID || again.ID != domain.ListTaskItemID(l.ID, t1.ID) {
		t.Fatalf("duplicate add should reuse the deterministic id: %s vs %s", again.ID, i1.ID)
	}
	items, _ := s.ListItems.ListForList(l.ID)
	if len(items) != 3 {
		t.Fatalf("items = %d, want 3", len(items))
	}
	if items[0].ID != i1.ID || items[1].ID != h.ID || items[2].ID != i2.ID {
		t.Fatalf("initial order wrong: %s %s %s", items[0].Kind, items[1].Kind, items[2].Kind)
	}

	// Drag the heading to the top, so both tasks fall under it.
	if err := s.ListItems.Reorder(l.ID, []string{h.ID, i1.ID, i2.ID}); err != nil {
		t.Fatalf("reorder: %v", err)
	}
	items, _ = s.ListItems.ListForList(l.ID)
	if items[0].Kind != domain.ListItemHeading || items[1].ID != i1.ID || items[2].ID != i2.ID {
		t.Fatalf("order after reorder wrong")
	}

	// Rename the heading; task items can't be retitled.
	name := "Waiting"
	if _, err := s.ListItems.Update(h.ID, UpdateListItemInput{Title: &name}); err != nil {
		t.Fatalf("rename heading: %v", err)
	}
	if _, err := s.ListItems.Update(i1.ID, UpdateListItemInput{Title: &name}); err == nil {
		t.Error("retitling a task item should fail")
	}

	// Removing then re-adding revives the tombstone at the end of the list.
	if err := s.ListItems.Remove(i1.ID); err != nil {
		t.Fatalf("remove: %v", err)
	}
	revived, _ := s.ListItems.AddTask(l.ID, t1.ID)
	items, _ = s.ListItems.ListForList(l.ID)
	if len(items) != 3 || items[2].ID != revived.ID || revived.DeletedAt != nil {
		t.Fatalf("revived item should be last and alive: %+v", items)
	}
	if ids, _ := s.ListItems.ListIDsForTask(t1.ID); len(ids) != 1 || ids[0] != l.ID {
		t.Fatalf("lists for task = %v", ids)
	}
}

func TestListItemsFollowProjectMembership(t *testing.T) {
	s, projectID := newListFixture(t)
	l, _ := s.Lists.Create(CreateListInput{ProjectID: projectID, Name: "Now"})
	task, _ := s.Tasks.Create(CreateTaskInput{Title: "One"})
	s.ListItems.AddTask(l.ID, task.ID)

	if err := s.ListItems.RemoveTaskFromProject(projectID, task.ID); err != nil {
		t.Fatalf("remove from project lists: %v", err)
	}
	if items, _ := s.ListItems.ListForList(l.ID); len(items) != 0 {
		t.Fatalf("task should have left the list, got %d items", len(items))
	}

	// Deleting a list tombstones its items too.
	s.ListItems.AddTask(l.ID, task.ID)
	if err := s.ListItems.DeleteForList(l.ID); err != nil {
		t.Fatalf("delete items: %v", err)
	}
	if err := s.Lists.Delete(l.ID); err != nil {
		t.Fatalf("delete list: %v", err)
	}
	if _, err := s.Lists.Get(l.ID); err != ErrNotFound {
		t.Fatalf("deleted list should be gone, err=%v", err)
	}
	dirty, _ := s.ListItems.Dirty()
	if len(dirty) != 1 || dirty[0].DeletedAt == nil {
		t.Fatalf("tombstoned item should be dirty for push: %+v", dirty)
	}
}
