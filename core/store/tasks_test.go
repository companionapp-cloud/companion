//go:build !js

package store

import (
	"testing"
	"time"
)

func TestTaskSeedHiddenFromListButInSeeds(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 6, 9, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	rule := "FREQ=WEEKLY;BYDAY=MO"
	due := clk.t
	seed, err := s.Tasks.Create(CreateTaskInput{Title: "Water plants", DueAt: &due, RepeatRule: &rule})
	if err != nil {
		t.Fatalf("create seed: %v", err)
	}
	if !seed.IsRepeatSeed() {
		t.Fatal("expected a repeat seed")
	}
	if _, err := s.Tasks.Create(CreateTaskInput{Title: "One-off"}); err != nil {
		t.Fatalf("create one-off: %v", err)
	}

	list, err := s.Tasks.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	for _, task := range list {
		if task.ID == seed.ID {
			t.Error("seed should not appear in the actionable task list")
		}
	}
	if len(list) != 1 {
		t.Errorf("List returned %d tasks, want 1 (the one-off)", len(list))
	}

	seeds, err := s.Tasks.ListSeeds()
	if err != nil {
		t.Fatalf("list seeds: %v", err)
	}
	if len(seeds) != 1 || seeds[0].ID != seed.ID {
		t.Errorf("ListSeeds = %+v, want just the seed", seeds)
	}
}

func TestTaskCreateRejectsBadRule(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 6, 9, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)
	bad := "FREQ=WHENEVER"
	if _, err := s.Tasks.Create(CreateTaskInput{Title: "x", RepeatRule: &bad}); err == nil {
		t.Error("expected create to reject a malformed RRULE")
	}
}

func TestTaskUpdateClearRepeatRule(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 6, 9, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)
	rule := "FREQ=DAILY"
	seed, err := s.Tasks.Create(CreateTaskInput{Title: "daily", RepeatRule: &rule})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := s.Tasks.Update(seed.ID, UpdateTaskInput{ClearRepeatRule: true})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if got.RepeatRule != nil {
		t.Errorf("repeat rule = %v, want nil after clear", *got.RepeatRule)
	}
	// Now a plain task, it appears in the actionable list.
	list, err := s.Tasks.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 1 || list[0].ID != seed.ID {
		t.Errorf("cleared seed should appear in List, got %+v", list)
	}
}
