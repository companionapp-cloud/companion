//go:build !js

package store

import (
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
