package bridge

import (
	"encoding/json"
	"testing"

	"companion/core/domain"
)

func createList(t *testing.T, c *Core, projectID, name string) *domain.List {
	t.Helper()
	out, err := c.Invoke("lists.create", []byte(`{"projectId":"`+projectID+`","name":"`+name+`"}`))
	if err != nil {
		t.Fatalf("lists.create: %v", err)
	}
	var l domain.List
	if err := json.Unmarshal(out, &l); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	return &l
}

func TestListsOverBridge(t *testing.T) {
	c, h := newTestCore(t)
	areaID := createArea(t, c, "Work")
	projectID := createProject(t, c, areaID, "Launch")

	// A list needs a real project.
	if _, err := c.Invoke("lists.create", []byte(`{"projectId":"nope","name":"X"}`)); err == nil {
		t.Fatal("expected error creating a list in a missing project")
	}
	l := createList(t, c, projectID, "Now")
	if h.count("lists.changed") != 1 {
		t.Errorf("lists.changed events = %d, want 1", h.count("lists.changed"))
	}

	// Creating a task through the list makes it a project member and a list item.
	out, err := c.Invoke("lists.createTask", []byte(`{"listId":"`+l.ID+`","title":"Ship it"}`))
	if err != nil {
		t.Fatalf("lists.createTask: %v", err)
	}
	var created struct {
		Task domain.Task     `json:"task"`
		Item domain.ListItem `json:"item"`
	}
	json.Unmarshal(out, &created)
	if created.Task.Title != "Ship it" || created.Item.TaskID == nil || *created.Item.TaskID != created.Task.ID {
		t.Fatalf("createTask result = %+v", created)
	}
	members, _ := c.store.ProjectMembers.ListForEntity(domain.NodeTask, created.Task.ID)
	if len(members) != 1 || members[0].ProjectID != projectID {
		t.Fatalf("task should be a project member: %+v", members)
	}

	// Adding an existing task (not yet in the project) joins the project too.
	out, _ = c.Invoke("tasks.create", []byte(`{"title":"Other"}`))
	var other domain.Task
	json.Unmarshal(out, &other)
	if _, err := c.Invoke("lists.addTask", []byte(`{"listId":"`+l.ID+`","taskId":"`+other.ID+`"}`)); err != nil {
		t.Fatalf("lists.addTask: %v", err)
	}
	if members, _ := c.store.ProjectMembers.ListForEntity(domain.NodeTask, other.ID); len(members) != 1 {
		t.Fatalf("added task should join the project: %+v", members)
	}
	if _, err := c.Invoke("lists.addHeading", []byte(`{"listId":"`+l.ID+`","title":"Later"}`)); err != nil {
		t.Fatalf("lists.addHeading: %v", err)
	}

	out, err = c.Invoke("lists.get", []byte(`{"id":"`+l.ID+`"}`))
	if err != nil {
		t.Fatalf("lists.get: %v", err)
	}
	var detail listDetail
	json.Unmarshal(out, &detail)
	if detail.List.Name != "Now" || len(detail.Items) != 3 {
		t.Fatalf("detail = %+v", detail)
	}

	// Reorder: heading first, then the two tasks.
	ids, _ := json.Marshal([]string{detail.Items[2].ID, detail.Items[1].ID, detail.Items[0].ID})
	if _, err := c.Invoke("lists.reorderItems", []byte(`{"listId":"`+l.ID+`","ids":`+string(ids)+`}`)); err != nil {
		t.Fatalf("lists.reorderItems: %v", err)
	}
	out, _ = c.Invoke("lists.items", []byte(`{"listId":"`+l.ID+`"}`))
	var items []domain.ListItem
	json.Unmarshal(out, &items)
	if items[0].Kind != domain.ListItemHeading || items[1].ID != detail.Items[1].ID {
		t.Fatalf("reordered items = %+v", items)
	}

	// Leaving the project drops the task from the list.
	if _, err := c.Invoke("projects.removeMember", []byte(`{"projectId":"`+projectID+`","entityType":"task","entityId":"`+other.ID+`"}`)); err != nil {
		t.Fatalf("projects.removeMember: %v", err)
	}
	out, _ = c.Invoke("lists.items", []byte(`{"listId":"`+l.ID+`"}`))
	json.Unmarshal(out, &items)
	if len(items) != 2 {
		t.Fatalf("items after leaving project = %d, want 2", len(items))
	}

	// Deleting the project cascades to its lists; the task survives.
	if _, err := c.Invoke("projects.delete", []byte(`{"id":"`+projectID+`"}`)); err != nil {
		t.Fatalf("projects.delete: %v", err)
	}
	if _, err := c.Invoke("lists.get", []byte(`{"id":"`+l.ID+`"}`)); err == nil {
		t.Fatal("list should be gone with its project")
	}
	if _, err := c.store.Tasks.Get(created.Task.ID); err != nil {
		t.Fatalf("task should survive list deletion: %v", err)
	}
}
