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
