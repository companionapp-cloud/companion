//go:build !js

package llm

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"companion/core/domain"
	"companion/core/store"
)

// TestWriteToolsFileEntities covers the projectId / listId / areaId arguments on the note,
// task and canvas write tools: they file the entity, a list files its project too, filing
// again moves it, and a bad id fails before anything is written.
func TestWriteToolsFileEntities(t *testing.T) {
	s := newTestStore(t)
	r := NewStoreRegistry(s)
	ctx := context.Background()

	area, err := s.Areas.Create(store.CreateAreaInput{Name: "Work"})
	if err != nil {
		t.Fatal(err)
	}
	proj, err := s.Projects.Create(store.CreateProjectInput{AreaID: area.ID, Name: "Q3 launch"})
	if err != nil {
		t.Fatal(err)
	}
	list, err := s.Lists.Create(store.CreateListInput{ProjectID: proj.ID, Name: "This week"})
	if err != nil {
		t.Fatal(err)
	}

	containerOf := func(entityType, id string) string {
		t.Helper()
		ms, err := s.ProjectMembers.ListForEntity(entityType, id)
		if err != nil {
			t.Fatal(err)
		}
		if len(ms) != 1 {
			t.Fatalf("%s %s has %d memberships, want 1", entityType, id, len(ms))
		}
		return ms[0].Container() + ":" + ms[0].ProjectID
	}

	// Discovery tools.
	if areas := invokeJSON[[]map[string]string](t, r, "list_areas", `{}`); len(areas) != 1 || areas[0]["id"] != area.ID {
		t.Errorf("list_areas = %+v", areas)
	}
	if lists := invokeJSON[[]map[string]string](t, r, "list_lists", `{"projectId":"`+proj.ID+`"}`); len(lists) != 1 || lists[0]["id"] != list.ID {
		t.Errorf("list_lists = %+v", lists)
	}

	// A task on a list lands in the list AND its project.
	task := invokeJSON[map[string]string](t, r, "create_task", `{"title":"Ship it","listId":"`+list.ID+`"}`)
	if got := containerOf(domain.NodeTask, task["id"]); got != "project:"+proj.ID {
		t.Errorf("task filed in %s", got)
	}
	if ids, _ := s.ListItems.ListIDsForTask(task["id"]); len(ids) != 1 || ids[0] != list.ID {
		t.Errorf("task lists = %v", ids)
	}
	// Moving it to the area takes it out of the project and its lists.
	invokeJSON[map[string]string](t, r, "update_task", `{"id":"`+task["id"]+`","areaId":"`+area.ID+`"}`)
	if got := containerOf(domain.NodeTask, task["id"]); got != "area:"+area.ID {
		t.Errorf("moved task filed in %s", got)
	}
	if ids, _ := s.ListItems.ListIDsForTask(task["id"]); len(ids) != 0 {
		t.Errorf("moved task still on lists %v", ids)
	}

	// Notes.
	note := invokeJSON[map[string]string](t, r, "create_note", `{"title":"Plan","areaId":"`+area.ID+`"}`)
	if got := containerOf(domain.NodeNote, note["id"]); got != "area:"+area.ID {
		t.Errorf("note filed in %s", got)
	}
	invokeJSON[map[string]string](t, r, "update_note", `{"id":"`+note["id"]+`","projectId":"`+proj.ID+`"}`)
	if got := containerOf(domain.NodeNote, note["id"]); got != "project:"+proj.ID {
		t.Errorf("moved note filed in %s", got)
	}

	// Canvases.
	cv := invokeJSON[map[string]string](t, r, "create_canvas", `{"name":"Roadmap","projectId":"`+proj.ID+`"}`)
	if cv["wikilink"] != "[[canvas:"+cv["id"]+"]]" {
		t.Errorf("create_canvas = %+v", cv)
	}
	if got := containerOf(domain.NodeCanvas, cv["id"]); got != "project:"+proj.ID {
		t.Errorf("canvas filed in %s", got)
	}
	renamed := invokeJSON[map[string]string](t, r, "update_canvas", `{"id":"`+cv["id"]+`","name":"Roadmap v2","areaId":"`+area.ID+`"}`)
	if renamed["title"] != "Roadmap v2" {
		t.Errorf("update_canvas = %+v", renamed)
	}
	if got := containerOf(domain.NodeCanvas, cv["id"]); got != "area:"+area.ID {
		t.Errorf("moved canvas filed in %s", got)
	}

	// null unsets: off the list (still in the project), then out of the project; an area
	// clear takes a note or canvas out of its area. A null for a container it isn't in is a no-op.
	invokeJSON[map[string]string](t, r, "update_task", `{"id":"`+task["id"]+`","listId":"`+list.ID+`"}`)
	invokeJSON[map[string]string](t, r, "update_task", `{"id":"`+task["id"]+`","listId":null}`)
	if ids, _ := s.ListItems.ListIDsForTask(task["id"]); len(ids) != 0 {
		t.Errorf("listId:null left the task on lists %v", ids)
	}
	if got := containerOf(domain.NodeTask, task["id"]); got != "project:"+proj.ID {
		t.Errorf("listId:null should keep the project, task filed in %s", got)
	}
	invokeJSON[map[string]string](t, r, "update_task", `{"id":"`+task["id"]+`","listId":"`+list.ID+`"}`)
	invokeJSON[map[string]string](t, r, "update_task", `{"id":"`+task["id"]+`","projectId":null,"areaId":null}`)
	unfiled := func(entityType, id string) {
		t.Helper()
		if ms, _ := s.ProjectMembers.ListForEntity(entityType, id); len(ms) != 0 {
			t.Errorf("%s %s still filed: %+v", entityType, id, ms)
		}
	}
	unfiled(domain.NodeTask, task["id"])
	if ids, _ := s.ListItems.ListIDsForTask(task["id"]); len(ids) != 0 {
		t.Errorf("projectId:null left the task on lists %v", ids)
	}
	invokeJSON[map[string]string](t, r, "update_note", `{"id":"`+note["id"]+`","areaId":null}`)
	if got := containerOf(domain.NodeNote, note["id"]); got != "project:"+proj.ID {
		t.Errorf("areaId:null moved a note that was in a project: %s", got)
	}
	invokeJSON[map[string]string](t, r, "update_note", `{"id":"`+note["id"]+`","projectId":null}`)
	unfiled(domain.NodeNote, note["id"])
	invokeJSON[map[string]string](t, r, "update_canvas", `{"id":"`+cv["id"]+`","areaId":null}`)
	unfiled(domain.NodeCanvas, cv["id"])
	if _, err := r.Invoke(ctx, "update_task", json.RawMessage(`{"id":"`+task["id"]+`","projectId":null,"listId":"`+list.ID+`"}`)); err == nil {
		t.Error("clearing projectId while setting listId should fail")
	}

	// Bad filings fail before anything is written.
	before, _ := s.Notes.List()
	for _, tc := range []struct{ tool, args, want string }{
		{"create_note", `{"title":"x","projectId":"nope"}`, "list_projects"},
		{"create_note", `{"title":"x","areaId":"nope"}`, "list_areas"},
		{"create_task", `{"title":"x","listId":"nope"}`, "list_lists"},
		{"create_task", `{"title":"x","projectId":"` + proj.ID + `","areaId":"` + area.ID + `"}`, "one place"},
		{"create_canvas", `{"name":"x","areaId":"nope"}`, "list_areas"},
	} {
		if _, err := r.Invoke(ctx, tc.tool, json.RawMessage(tc.args)); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s(%s) err = %v, want mention of %q", tc.tool, tc.args, err, tc.want)
		}
	}
	if after, _ := s.Notes.List(); len(after) != len(before) {
		t.Errorf("a failed filing still created a note")
	}
	if tasks, _ := s.Tasks.List(); len(tasks) != 1 {
		t.Errorf("a failed filing still created a task: %d tasks", len(tasks))
	}
}
