//go:build !js

package store

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"companion/core/domain"
)

// TestSearchNotesAndTasks proves the FTS5 indexes are live under modernc: notes and tasks
// are searchable by title and body, prefix matching works, and results merge across both
// entity types.
func TestSearchNotesAndTasks(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 5, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	if _, err := s.Notes.Create(CreateNoteInput{Title: "Q3 planning", ContentMD: "Goals, owners, and the messy middle."}); err != nil {
		t.Fatalf("create note: %v", err)
	}
	if _, err := s.Notes.Create(CreateNoteInput{Title: "Pricing experiments", ContentMD: "Annual toggle moved the needle."}); err != nil {
		t.Fatalf("create note: %v", err)
	}
	if _, err := s.Tasks.Create(CreateTaskInput{Title: "Draft Q3 plan", NotesMD: "Pull goals from the planning note."}); err != nil {
		t.Fatalf("create task: %v", err)
	}

	// Prefix match on "plan" hits the "planning" note title and the "plan"/"planning" task.
	hits, err := s.Search.Search("plan", 10)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(hits) != 2 {
		t.Fatalf("expected 2 hits for 'plan', got %d: %+v", len(hits), hits)
	}
	var sawNote, sawTask bool
	for _, h := range hits {
		switch h.Type {
		case domain.NodeNote:
			sawNote = true
		case domain.NodeTask:
			sawTask = true
		}
	}
	if !sawNote || !sawTask {
		t.Errorf("expected a note and a task hit, got %+v", hits)
	}

	// Body-only term matches.
	if hits, _ := s.Search.Search("needle", 10); len(hits) != 1 || hits[0].Title != "Pricing experiments" {
		t.Errorf("body search failed: %+v", hits)
	}

	// Punctuation-only / empty queries are safe no-ops, not errors.
	if hits, err := s.Search.Search("  @#$  ", 10); err != nil || len(hits) != 0 {
		t.Errorf("expected empty result for junk query, got %+v (err %v)", hits, err)
	}
}

// TestSearchByObjectProps proves a note/task is findable by its archetype metadata
// (props_json), not just its title or prose body — the LLM's search_notes tool relies on
// this to answer questions about structured objects.
func TestSearchByObjectProps(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	schema := mustSchema(domain.ObjectSchema{Fields: []domain.ObjectField{
		{Key: "isbn", Type: domain.FieldText},
	}})
	ot, err := s.ObjectTypes.Create(CreateObjectTypeInput{Name: "Book", AppliesTo: domain.AppliesToNote, SchemaJSON: schema})
	if err != nil {
		t.Fatalf("create object type: %v", err)
	}

	// A note whose only mention of the term is in a structured prop, not the title or body.
	if _, err := s.Notes.Create(CreateNoteInput{
		Title:        "A book",
		ContentMD:    "no keywords here",
		ObjectTypeID: &ot.ID,
		Props:        json.RawMessage(`{"isbn":"9780261102217"}`),
	}); err != nil {
		t.Fatalf("create note: %v", err)
	}

	hits, err := s.Search.Search("9780261102217", 10)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(hits) != 1 || hits[0].Title != "A book" {
		t.Fatalf("expected the note by its isbn prop, got %+v", hits)
	}
	// The snippet should surface the matched metadata, not the unrelated body head.
	if !strings.Contains(hits[0].Snippet, "9780261102217") {
		t.Errorf("snippet should include the matched prop value, got %q", hits[0].Snippet)
	}
}

// TestQueryObjects proves structured querying over an archetype: listing all objects of a
// type and narrowing by field values (case-insensitive substring, ALL filters ANDed),
// spanning both notes and tasks. This is what lets the LLM answer "which People are in Berlin".
func TestQueryObjects(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	schema := mustSchema(domain.ObjectSchema{Fields: []domain.ObjectField{
		{Key: "city", Type: domain.FieldText},
		{Key: "tags", Type: domain.FieldMultiSelect, Options: []string{"vip", "lead"}},
	}})
	person, err := s.ObjectTypes.Create(CreateObjectTypeInput{Name: "Person", AppliesTo: domain.AppliesToBoth, SchemaJSON: schema})
	if err != nil {
		t.Fatalf("create object type: %v", err)
	}

	if _, err := s.Notes.Create(CreateNoteInput{Title: "Anna", ObjectTypeID: &person.ID, Props: json.RawMessage(`{"city":"Berlin, Germany","tags":["vip"]}`)}); err != nil {
		t.Fatalf("create note: %v", err)
	}
	if _, err := s.Notes.Create(CreateNoteInput{Title: "Bob", ObjectTypeID: &person.ID, Props: json.RawMessage(`{"city":"Paris","tags":["lead"]}`)}); err != nil {
		t.Fatalf("create note: %v", err)
	}
	// A task of the same archetype, and a plain note that must never appear.
	if _, err := s.Tasks.Create(CreateTaskInput{Title: "Call Cara", ObjectTypeID: &person.ID, Props: json.RawMessage(`{"city":"berlin"}`)}); err != nil {
		t.Fatalf("create task: %v", err)
	}
	if _, err := s.Notes.Create(CreateNoteInput{Title: "Berlin trip", ContentMD: "not an object"}); err != nil {
		t.Fatalf("create note: %v", err)
	}

	// No filters: every Person object across notes and tasks (not the plain note).
	all, err := s.Search.QueryObjects(person.ID, nil, 10)
	if err != nil {
		t.Fatalf("query objects: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("expected 3 Person objects, got %d: %+v", len(all), all)
	}

	// Filter by city: case-insensitive substring matches "Berlin, Germany" (note) and
	// "berlin" (task), but not "Paris".
	byCity, err := s.Search.QueryObjects(person.ID, map[string]string{"city": "berlin"}, 10)
	if err != nil {
		t.Fatalf("query by city: %v", err)
	}
	if len(byCity) != 2 {
		t.Fatalf("expected 2 objects in Berlin, got %d: %+v", len(byCity), byCity)
	}

	// Filters AND together, and match into array (multi_select) values.
	both, err := s.Search.QueryObjects(person.ID, map[string]string{"city": "berlin", "tags": "vip"}, 10)
	if err != nil {
		t.Fatalf("query anded: %v", err)
	}
	if len(both) != 1 || both[0].Title != "Anna" {
		t.Fatalf("expected only Anna, got %+v", both)
	}

	// A filter on an absent value returns nothing.
	if none, _ := s.Search.QueryObjects(person.ID, map[string]string{"city": "tokyo"}, 10); len(none) != 0 {
		t.Errorf("expected no matches for tokyo, got %+v", none)
	}
}

// TestSearchExcludesTrashed guards the query-time live-state filter: a trashed note must
// drop out of results even though its row (and its FTS entry) still exist.
func TestSearchExcludesTrashed(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 5, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	n, err := s.Notes.Create(CreateNoteInput{Title: "Ambient capture idea", ContentMD: "What if notes wrote themselves?"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if hits, _ := s.Search.Search("ambient", 10); len(hits) != 1 {
		t.Fatalf("expected the note before trashing, got %+v", hits)
	}
	if err := s.Notes.Trash(n.ID); err != nil {
		t.Fatalf("trash: %v", err)
	}
	if hits, _ := s.Search.Search("ambient", 10); len(hits) != 0 {
		t.Errorf("trashed note should not appear in search, got %+v", hits)
	}
	// Restoring brings it back.
	if err := s.Notes.Restore(n.ID); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if hits, _ := s.Search.Search("ambient", 10); len(hits) != 1 {
		t.Errorf("restored note should reappear in search, got %+v", hits)
	}
}
