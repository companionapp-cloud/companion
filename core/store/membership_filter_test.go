//go:build !js

package store

import (
	"testing"
	"time"
)

// MemberEntityIDs backs the "Unsorted vs All" browse filter (PLAN §6.6): it returns exactly
// the entities that belong to a live project, and drops them once membership is removed.
func TestMemberEntityIDs(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 8, 9, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	area, _ := s.Areas.Create(CreateAreaInput{Name: "Work"})
	proj, _ := s.Projects.Create(CreateProjectInput{AreaID: area.ID, Name: "Launch"})
	sorted, _ := s.Notes.Create(CreateNoteInput{Title: "In a project"})
	if _, err := s.Notes.Create(CreateNoteInput{Title: "Loose note"}); err != nil {
		t.Fatalf("create note: %v", err)
	}
	if _, err := s.ProjectMembers.Add(proj.ID, "note", sorted.ID); err != nil {
		t.Fatalf("add member: %v", err)
	}

	ids, err := s.ProjectMembers.MemberEntityIDs("note")
	if err != nil {
		t.Fatalf("member ids: %v", err)
	}
	if len(ids) != 1 || ids[0] != sorted.ID {
		t.Fatalf("member ids = %v, want [%s]", ids, sorted.ID)
	}
	// Tasks have no members → empty (not nil).
	if taskIDs, _ := s.ProjectMembers.MemberEntityIDs("task"); len(taskIDs) != 0 {
		t.Errorf("task member ids = %v, want none", taskIDs)
	}

	// Removing the membership makes the note "unsorted" again.
	if err := s.ProjectMembers.Remove(proj.ID, "note", sorted.ID); err != nil {
		t.Fatalf("remove member: %v", err)
	}
	if ids, _ := s.ProjectMembers.MemberEntityIDs("note"); len(ids) != 0 {
		t.Errorf("after removal member ids = %v, want none", ids)
	}
}
