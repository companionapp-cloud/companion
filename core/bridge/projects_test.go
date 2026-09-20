package bridge

import (
	"encoding/json"
	"testing"

	"companion/core/domain"
)

// createArea creates an area over the bridge and returns its id.
func createArea(t *testing.T, c *Core, name string) string {
	t.Helper()
	out, err := c.Invoke("areas.create", []byte(`{"name":"`+name+`"}`))
	if err != nil {
		t.Fatalf("areas.create: %v", err)
	}
	var a domain.Area
	if err := json.Unmarshal(out, &a); err != nil {
		t.Fatalf("decode area: %v", err)
	}
	return a.ID
}

// createProject creates a project in an area over the bridge and returns its id.
func createProject(t *testing.T, c *Core, areaID, name string) string {
	t.Helper()
	out, err := c.Invoke("projects.create", []byte(`{"areaId":"`+areaID+`","name":"`+name+`"}`))
	if err != nil {
		t.Fatalf("projects.create: %v", err)
	}
	var p domain.Project
	if err := json.Unmarshal(out, &p); err != nil {
		t.Fatalf("decode project: %v", err)
	}
	return p.ID
}

// A non-empty area can't be deleted; once its projects are gone, the delete succeeds.
func TestAreaDeleteRequiresEmpty(t *testing.T) {
	c, _ := newTestCore(t)
	areaID := createArea(t, c, "Work")
	projectID := createProject(t, c, areaID, "Launch")

	if _, err := c.Invoke("areas.delete", []byte(`{"id":"`+areaID+`"}`)); err == nil {
		t.Fatal("expected error deleting a non-empty area")
	}

	// Delete the project, then the area is deletable.
	if _, err := c.Invoke("projects.delete", []byte(`{"id":"`+projectID+`"}`)); err != nil {
		t.Fatalf("projects.delete: %v", err)
	}
	if _, err := c.Invoke("areas.delete", []byte(`{"id":"`+areaID+`"}`)); err != nil {
		t.Fatalf("areas.delete on empty area: %v", err)
	}

	// The area is gone from the list.
	out, err := c.Invoke("areas.list", nil)
	if err != nil {
		t.Fatalf("areas.list: %v", err)
	}
	var areas []domain.Area
	json.Unmarshal(out, &areas)
	if len(areas) != 0 {
		t.Fatalf("areas remaining = %d, want 0", len(areas))
	}
}

// Deleting a project without deleteContent keeps the member note alive (it falls back to
// Unsorted); with deleteContent the note is trashed.
func TestProjectDeleteContentMode(t *testing.T) {
	noteID := func(t *testing.T, c *Core) string {
		t.Helper()
		out, err := c.Invoke("notes.create", []byte(`{"title":"Doc","contentMd":"body"}`))
		if err != nil {
			t.Fatalf("notes.create: %v", err)
		}
		var n domain.Note
		json.Unmarshal(out, &n)
		return n.ID
	}
	noteAlive := func(t *testing.T, c *Core, id string) bool {
		t.Helper()
		out, err := c.Invoke("notes.list", nil)
		if err != nil {
			t.Fatalf("notes.list: %v", err)
		}
		var list []domain.Note
		json.Unmarshal(out, &list)
		for _, n := range list {
			if n.ID == id {
				return true
			}
		}
		return false
	}

	t.Run("keep content", func(t *testing.T) {
		c, _ := newTestCore(t)
		areaID := createArea(t, c, "Work")
		projectID := createProject(t, c, areaID, "Launch")
		nID := noteID(t, c)
		if _, err := c.Invoke("projects.addMember", []byte(`{"projectId":"`+projectID+`","entityType":"note","entityId":"`+nID+`"}`)); err != nil {
			t.Fatalf("addMember: %v", err)
		}
		if _, err := c.Invoke("projects.delete", []byte(`{"id":"`+projectID+`"}`)); err != nil {
			t.Fatalf("projects.delete: %v", err)
		}
		if !noteAlive(t, c, nID) {
			t.Fatal("note should stay alive when content is kept")
		}
	})

	t.Run("delete content", func(t *testing.T) {
		c, _ := newTestCore(t)
		areaID := createArea(t, c, "Work")
		projectID := createProject(t, c, areaID, "Launch")
		nID := noteID(t, c)
		if _, err := c.Invoke("projects.addMember", []byte(`{"projectId":"`+projectID+`","entityType":"note","entityId":"`+nID+`"}`)); err != nil {
			t.Fatalf("addMember: %v", err)
		}
		if _, err := c.Invoke("projects.delete", []byte(`{"id":"`+projectID+`","deleteContent":true}`)); err != nil {
			t.Fatalf("projects.delete: %v", err)
		}
		if noteAlive(t, c, nID) {
			t.Fatal("note should be trashed when content is deleted")
		}
	})
}

// Content filed directly in an area is reachable over the bridge, moves when filed elsewhere,
// and falls back to Unsorted when its area is deleted (PLAN-areas.md §2).
func TestAreaMembersOverBridge(t *testing.T) {
	c, _ := newTestCore(t)
	areaID := createArea(t, c, "Health")
	projectID := createProject(t, c, areaID, "Run a 10k")
	noteOut, err := c.Invoke("notes.create", []byte(`{"title":"Training log"}`))
	if err != nil {
		t.Fatalf("notes.create: %v", err)
	}
	var note domain.Note
	if err := json.Unmarshal(noteOut, &note); err != nil {
		t.Fatalf("decode note: %v", err)
	}
	member := `{"areaId":"` + areaID + `","entityType":"note","entityId":"` + note.ID + `"}`
	if _, err := c.Invoke("areas.addMember", []byte(member)); err != nil {
		t.Fatalf("areas.addMember: %v", err)
	}
	if _, err := c.Invoke("areas.addMember", []byte(`{"areaId":"`+areaID+`","entityType":"calendar","entityId":"x"}`)); err == nil {
		t.Error("an area accepted a calendar over the bridge")
	}

	members := func(method, payload string) []domain.ProjectMember {
		t.Helper()
		out, err := c.Invoke(method, []byte(payload))
		if err != nil {
			t.Fatalf("%s: %v", method, err)
		}
		var ms []domain.ProjectMember
		if err := json.Unmarshal(out, &ms); err != nil {
			t.Fatalf("decode members: %v", err)
		}
		return ms
	}
	if ms := members("areas.members", `{"areaId":"`+areaID+`"}`); len(ms) != 1 || ms[0].ContainerType != domain.ContainerArea {
		t.Fatalf("area members = %+v", ms)
	}

	// Filing it in the project moves it out of the area; the tree still rolls it up.
	if _, err := c.Invoke("projects.addMember", []byte(`{"projectId":"`+projectID+`","entityType":"note","entityId":"`+note.ID+`"}`)); err != nil {
		t.Fatalf("projects.addMember: %v", err)
	}
	if ms := members("areas.members", `{"areaId":"`+areaID+`"}`); len(ms) != 0 {
		t.Errorf("area still holds the note after it moved: %+v", ms)
	}
	if ms := members("areas.members", `{"areaId":"`+areaID+`","tree":true}`); len(ms) != 1 || ms[0].ProjectID != projectID {
		t.Errorf("area tree = %+v, want the project's note", ms)
	}
	if ms := members("projects.forEntity", `{"entityType":"note","entityId":"`+note.ID+`"}`); len(ms) != 1 {
		t.Errorf("note memberships = %+v, want exactly one", ms)
	}

	// Back in the area; deleting the (project-less) area unfiles it without trashing it.
	if _, err := c.Invoke("areas.addMember", []byte(member)); err != nil {
		t.Fatalf("areas.addMember (back): %v", err)
	}
	if _, err := c.Invoke("projects.delete", []byte(`{"id":"`+projectID+`"}`)); err != nil {
		t.Fatalf("projects.delete: %v", err)
	}
	if _, err := c.Invoke("areas.delete", []byte(`{"id":"`+areaID+`"}`)); err != nil {
		t.Fatalf("areas.delete: %v", err)
	}
	if ms := members("projects.forEntity", `{"entityType":"note","entityId":"`+note.ID+`"}`); len(ms) != 0 {
		t.Errorf("note still filed after its area was deleted: %+v", ms)
	}
	if _, err := c.Invoke("notes.get", []byte(`{"id":"`+note.ID+`"}`)); err != nil {
		t.Errorf("note should survive its area's deletion: %v", err)
	}
}

// Completing a project with completeTasks finishes its open tasks alongside it, so the whole
// project lands in the Logbook together; tasks filed elsewhere are untouched.
func TestCompleteProjectCompletesItsOpenTasks(t *testing.T) {
	c, _ := newTestCore(t)
	areaID := createArea(t, c, "Work")
	projectID := createProject(t, c, areaID, "Launch")

	open := invoke[domain.Task](t, c, "tasks.create", map[string]any{"title": "Ship"})
	cancelled := invoke[domain.Task](t, c, "tasks.create", map[string]any{"title": "Skip", "status": "cancelled"})
	elsewhere := invoke[domain.Task](t, c, "tasks.create", map[string]any{"title": "Unrelated"})
	for _, id := range []string{open.ID, cancelled.ID} {
		invoke[domain.ProjectMember](t, c, "projects.addMember", map[string]any{"projectId": projectID, "entityType": "task", "entityId": id})
	}

	p := invoke[domain.Project](t, c, "projects.update", map[string]any{"id": projectID, "completed": true, "completeTasks": true})
	if p.CompletedAt == nil {
		t.Fatal("project not completed")
	}
	status := func(id string) string {
		return invoke[domain.Task](t, c, "tasks.get", map[string]any{"id": id}).Status
	}
	if got := status(open.ID); got != domain.TaskDone {
		t.Errorf("open member = %s, want done", got)
	}
	if got := status(cancelled.ID); got != domain.TaskCancelled {
		t.Errorf("cancelled member = %s, want it left cancelled", got)
	}
	if got := status(elsewhere.ID); got != domain.TaskOpen {
		t.Errorf("unrelated task = %s, want open", got)
	}

	// Reopening the project does not reopen its tasks.
	p = invoke[domain.Project](t, c, "projects.update", map[string]any{"id": projectID, "completed": false})
	if p.CompletedAt != nil || status(open.ID) != domain.TaskDone {
		t.Errorf("reopened: completedAt %v, task %s", p.CompletedAt, status(open.ID))
	}
}
