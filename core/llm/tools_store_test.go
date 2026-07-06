//go:build !js

package llm

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"companion/core/domain"
	"companion/core/store"
)

func newTestStore(t *testing.T) *store.Store {
	t.Helper()
	s, err := store.Open(":memory:", nil)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

// TestStoreToolsRoundTrip exercises the tool registry the way the orchestration loop will:
// a write tool creates an entity, a read tool finds it, and the write result carries a
// usable wikilink.
func TestStoreToolsRoundTrip(t *testing.T) {
	s := newTestStore(t)
	r := NewStoreRegistry(s)
	ctx := context.Background()

	// create_task returns an id + wikilink.
	out, err := r.Invoke(ctx, "create_task", json.RawMessage(`{"title":"Draft Q3 plan","notesMd":"Pull goals from the planning note."}`))
	if err != nil {
		t.Fatalf("create_task: %v", err)
	}
	var created map[string]string
	if err := json.Unmarshal([]byte(out), &created); err != nil {
		t.Fatalf("unmarshal create result: %v", err)
	}
	taskID := created["id"]
	if taskID == "" {
		t.Fatal("create_task returned no id")
	}
	if want := "[[task:" + taskID + "]]"; created["wikilink"] != want {
		t.Errorf("wikilink = %q, want %q", created["wikilink"], want)
	}
	if !r.IsWrite("create_task") || r.IsWrite("search_notes") {
		t.Error("Write flags are wrong")
	}

	// search_notes finds the task by a body term.
	out, err = r.Invoke(ctx, "search_notes", json.RawMessage(`{"query":"planning"}`))
	if err != nil {
		t.Fatalf("search_notes: %v", err)
	}
	var hits []domain.SearchHit
	if err := json.Unmarshal([]byte(out), &hits); err != nil {
		t.Fatalf("unmarshal hits: %v", err)
	}
	if len(hits) != 1 || hits[0].ID != taskID {
		t.Fatalf("expected to find the task, got %+v", hits)
	}

	// update_task marks it done.
	if _, err := r.Invoke(ctx, "update_task", json.RawMessage(`{"id":"`+taskID+`","status":"done"}`)); err != nil {
		t.Fatalf("update_task: %v", err)
	}
	got, err := s.Tasks.Get(taskID)
	if err != nil {
		t.Fatalf("get task: %v", err)
	}
	if got.Status != "done" {
		t.Errorf("status = %q, want done", got.Status)
	}
}

// TestListProjectItems checks that the tool resolves a project's members back to their
// live notes and tasks, honours the type filter, and skips memberships whose entity has
// been trashed.
func TestListProjectItems(t *testing.T) {
	s := newTestStore(t)
	r := NewStoreRegistry(s)
	ctx := context.Background()

	area, err := s.Areas.Create(store.CreateAreaInput{Name: "Work"})
	if err != nil {
		t.Fatalf("create area: %v", err)
	}
	proj, err := s.Projects.Create(store.CreateProjectInput{AreaID: area.ID, Name: "Q3 launch"})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	note, err := s.Notes.Create(store.CreateNoteInput{Title: "Launch checklist"})
	if err != nil {
		t.Fatalf("create note: %v", err)
	}
	task, err := s.Tasks.Create(store.CreateTaskInput{Title: "Book venue"})
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	for _, m := range []struct{ typ, id string }{
		{"note", note.ID}, {"task", task.ID},
	} {
		if _, err := s.ProjectMembers.Add(proj.ID, m.typ, m.id); err != nil {
			t.Fatalf("add member %s: %v", m.typ, err)
		}
	}

	type result struct {
		Notes []*domain.Note `json:"notes"`
		Tasks []*domain.Task `json:"tasks"`
	}

	// Both kinds by default.
	out, err := r.Invoke(ctx, "list_project_items", json.RawMessage(`{"projectId":"`+proj.ID+`"}`))
	if err != nil {
		t.Fatalf("list_project_items: %v", err)
	}
	var got result
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Notes) != 1 || got.Notes[0].ID != note.ID {
		t.Errorf("notes = %+v, want the one note", got.Notes)
	}
	if len(got.Tasks) != 1 || got.Tasks[0].ID != task.ID {
		t.Errorf("tasks = %+v, want the one task", got.Tasks)
	}

	// type filter restricts to tasks only.
	out, err = r.Invoke(ctx, "list_project_items", json.RawMessage(`{"projectId":"`+proj.ID+`","type":"task"}`))
	if err != nil {
		t.Fatalf("list_project_items (task): %v", err)
	}
	got = result{}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Notes) != 0 || len(got.Tasks) != 1 {
		t.Errorf("type filter ignored: %+v", got)
	}

	// A trashed entity's stale membership is skipped, not an error.
	if err := s.Notes.Delete(note.ID); err != nil {
		t.Fatalf("trash note: %v", err)
	}
	out, err = r.Invoke(ctx, "list_project_items", json.RawMessage(`{"projectId":"`+proj.ID+`"}`))
	if err != nil {
		t.Fatalf("list_project_items (post-trash): %v", err)
	}
	got = result{}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Notes) != 0 {
		t.Errorf("expected trashed note to be skipped, got %+v", got.Notes)
	}
}

// TestStoreToolsSpecsDeterministic guards that the advertised tool list is stable and
// name-sorted, so it doesn't churn the prompt-cache prefix between requests.
func TestStoreToolsSpecsDeterministic(t *testing.T) {
	s := newTestStore(t)
	r := NewStoreRegistry(s)
	specs := r.Specs()
	if len(specs) != 16 {
		t.Fatalf("expected 16 tools, got %d", len(specs))
	}
	for i := 1; i < len(specs); i++ {
		if specs[i-1].Name > specs[i].Name {
			t.Errorf("specs not name-sorted: %q before %q", specs[i-1].Name, specs[i].Name)
		}
		// Every advertised schema must be valid JSON so providers can embed it verbatim.
		if !json.Valid(specs[i].Schema) {
			t.Errorf("tool %q has invalid schema JSON", specs[i].Name)
		}
	}
}

// TestCreateTaskDueAt confirms the RFC3339 due-date path parses and reaches the store.
func TestCreateTaskDueAt(t *testing.T) {
	s := newTestStore(t)
	r := NewStoreRegistry(s)
	out, err := r.Invoke(context.Background(), "create_task",
		json.RawMessage(`{"title":"Ship it","dueAt":"2026-07-10T09:00:00Z","remindAt":"2026-07-10T08:00:00Z"}`))
	if err != nil {
		t.Fatalf("create_task with due: %v", err)
	}
	var created map[string]string
	json.Unmarshal([]byte(out), &created)
	got, err := s.Tasks.Get(created["id"])
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.DueAt == nil || !got.DueAt.Equal(time.Date(2026, 7, 10, 9, 0, 0, 0, time.UTC)) {
		t.Errorf("dueAt not stored: %+v", got.DueAt)
	}
	// The reminder is a field on the same task, an hour before the due date.
	if got.RemindAt == nil || !got.RemindAt.Equal(time.Date(2026, 7, 10, 8, 0, 0, 0, time.UTC)) {
		t.Errorf("remindAt not stored: %+v", got.RemindAt)
	}

	// A malformed due timestamp is a tool error, surfaced to the model, not a panic.
	if _, err := r.Invoke(context.Background(), "create_task",
		json.RawMessage(`{"title":"x","dueAt":"tomorrow"}`)); err == nil || !strings.Contains(err.Error(), "RFC3339") {
		t.Errorf("expected RFC3339 error, got %v", err)
	}
}

// TestGetDate checks the get_date tool returns today's local date in a parseable shape.
func TestGetDate(t *testing.T) {
	s := newTestStore(t)
	r := NewStoreRegistry(s)
	out, err := r.Invoke(context.Background(), "get_date", json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("get_date: %v", err)
	}
	var got struct {
		Date    string `json:"date"`
		Weekday string `json:"weekday"`
		ISO     string `json:"iso"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, err := time.Parse("2006-01-02", got.Date); err != nil {
		t.Errorf("date not YYYY-MM-DD: %q", got.Date)
	}
	if _, err := time.Parse(time.RFC3339, got.ISO); err != nil {
		t.Errorf("iso not RFC3339: %q", got.ISO)
	}
	if got.Weekday == "" {
		t.Error("weekday missing")
	}
}
