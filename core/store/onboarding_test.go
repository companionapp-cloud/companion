//go:build !js

package store

import (
	"errors"
	"testing"
	"time"

	"companion/core/domain"
)

func TestOnboardingRecordIsIdempotentPerVersion(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	rows, err := s.Onboarding.Record([]OnboardingEntry{
		{Tour: "today", TourVersion: 1, Outcome: domain.OnboardingCompleted},
		{Tour: "chat", TourVersion: 2, Outcome: domain.OnboardingSkipped},
	})
	if err != nil {
		t.Fatalf("record: %v", err)
	}
	if len(rows) != 2 || !rows[0].Dirty || rows[0].Tour != "today" || rows[1].Outcome != domain.OnboardingSkipped {
		t.Fatalf("rows = %+v", rows)
	}

	// The same version, or an older one, keeps the row already there.
	clk.t = clk.t.Add(time.Minute)
	again, err := s.Onboarding.Record([]OnboardingEntry{
		{Tour: "today", TourVersion: 1, Outcome: domain.OnboardingSkipped},
		{Tour: "chat", TourVersion: 1, Outcome: domain.OnboardingCompleted},
	})
	if err != nil {
		t.Fatalf("record again: %v", err)
	}
	if again[0].ID != rows[0].ID || again[0].Outcome != domain.OnboardingCompleted || again[1].ID != rows[1].ID {
		t.Errorf("re-record wrote new rows: %+v", again)
	}

	// A newer version is a tour of its own.
	newer, err := s.Onboarding.Record([]OnboardingEntry{{Tour: "today", TourVersion: 2, Outcome: domain.OnboardingCompleted}})
	if err != nil {
		t.Fatalf("record v2: %v", err)
	}
	if newer[0].ID == rows[0].ID {
		t.Error("a newer version should get its own row")
	}

	all, err := s.Onboarding.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != 3 {
		t.Errorf("list = %d rows, want 3", len(all))
	}
}

func TestOnboardingRecordValidates(t *testing.T) {
	s := newTestStore(t, &fixedClock{t: time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)})
	for _, e := range []OnboardingEntry{
		{Tour: "", TourVersion: 1, Outcome: domain.OnboardingCompleted},
		{Tour: "Today!", TourVersion: 1, Outcome: domain.OnboardingCompleted},
		{Tour: "today", TourVersion: 0, Outcome: domain.OnboardingCompleted},
		{Tour: "today", TourVersion: 1, Outcome: "maybe"},
	} {
		if _, err := s.Onboarding.Record([]OnboardingEntry{e}); !errors.Is(err, domain.ErrInvalidOnboarding) {
			t.Errorf("record %+v: err = %v, want ErrInvalidOnboarding", e, err)
		}
	}
}

func TestOnboardingReset(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)
	if _, err := s.Onboarding.Record([]OnboardingEntry{
		{Tour: "today", TourVersion: 1, Outcome: domain.OnboardingCompleted},
		{Tour: "notes", TourVersion: 1, Outcome: domain.OnboardingCompleted},
		{Tour: "tasks", TourVersion: 1, Outcome: domain.OnboardingSkipped},
	}); err != nil {
		t.Fatalf("record: %v", err)
	}
	// Pretend they were pushed, so the reset has to dirty them again.
	all, _ := s.Onboarding.List()
	for _, o := range all {
		if err := s.Onboarding.MarkPushed(o.ID, 1); err != nil {
			t.Fatalf("mark pushed: %v", err)
		}
	}

	n, err := s.Onboarding.Reset([]string{"notes"})
	if err != nil || n != 1 {
		t.Fatalf("reset notes = %d, %v; want 1", n, err)
	}
	left, _ := s.Onboarding.List()
	if len(left) != 2 {
		t.Errorf("after resetting notes, %d rows left, want 2", len(left))
	}
	dirty, _ := s.Onboarding.Dirty()
	if len(dirty) != 1 || dirty[0].Tour != "notes" || dirty[0].DeletedAt == nil {
		t.Errorf("dirty = %+v, want the notes tombstone", dirty)
	}

	// A reset tour settles afresh.
	if _, err := s.Onboarding.Record([]OnboardingEntry{{Tour: "notes", TourVersion: 1, Outcome: domain.OnboardingCompleted}}); err != nil {
		t.Fatalf("record after reset: %v", err)
	}

	if n, err := s.Onboarding.Reset(nil); err != nil || n != 3 {
		t.Fatalf("reset all = %d, %v; want 3", n, err)
	}
	if left, _ := s.Onboarding.List(); len(left) != 0 {
		t.Errorf("after resetting everything, %d rows left", len(left))
	}
}

func TestOnboardingSyncSurface(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)
	rows, err := s.Onboarding.Record([]OnboardingEntry{{Tour: "graph", TourVersion: 3, Outcome: domain.OnboardingCompleted}})
	if err != nil {
		t.Fatalf("record: %v", err)
	}
	if err := s.Onboarding.MarkPushed(rows[0].ID, 4); err != nil {
		t.Fatalf("mark pushed: %v", err)
	}
	got, err := s.Onboarding.GetAny(rows[0].ID)
	if err != nil || got.Dirty || got.Version != 4 {
		t.Fatalf("after push: %+v (err %v)", got, err)
	}

	// A row pulled from another device lands clean, and a pulled tombstone removes it.
	other := &domain.Onboarding{
		ID: "5f0c8f5e-4a53-4f3c-9d1e-2b7f3c9a1d20", Tour: "today", TourVersion: 1, Outcome: domain.OnboardingSkipped,
		CreatedAt: clk.t, UpdatedAt: clk.t, Version: 1,
	}
	raw := []byte(`{"id":"5f0c8f5e-4a53-4f3c-9d1e-2b7f3c9a1d20","tour":"today","tourVersion":1,"outcome":"skipped","createdAt":"2026-09-22T12:00:00Z","updatedAt":"2026-09-22T12:00:00Z","version":1}`)
	decoded, err := s.Onboarding.Decode(raw)
	if err != nil || decoded.Tour != other.Tour || decoded.TourVersion != 1 || decoded.Outcome != other.Outcome {
		t.Fatalf("decode = %+v (err %v)", decoded, err)
	}
	if err := s.Onboarding.Apply(decoded); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if all, _ := s.Onboarding.List(); len(all) != 2 {
		t.Errorf("after pull, %d rows, want 2", len(all))
	}
	deleted := clk.t.Add(time.Hour)
	decoded.DeletedAt = &deleted
	decoded.Version = 2
	if err := s.Onboarding.Apply(decoded); err != nil {
		t.Fatalf("apply tombstone: %v", err)
	}
	if all, _ := s.Onboarding.List(); len(all) != 1 {
		t.Errorf("after pulled reset, %d rows, want 1", len(all))
	}
	if dirty, _ := s.Onboarding.Dirty(); len(dirty) != 0 {
		t.Errorf("pulled rows should be clean, dirty = %+v", dirty)
	}
}

func TestOnboardingRecordReplace(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)
	on, err := s.Onboarding.Record([]OnboardingEntry{{Tour: "tutorials", TourVersion: 1, Outcome: domain.OnboardingCompleted, Replace: true}})
	if err != nil {
		t.Fatalf("record: %v", err)
	}
	// A plain record keeps the row; a replace swaps it for the new answer.
	clk.t = clk.t.Add(time.Minute)
	kept, _ := s.Onboarding.Record([]OnboardingEntry{{Tour: "tutorials", TourVersion: 1, Outcome: domain.OnboardingSkipped}})
	if kept[0].ID != on[0].ID {
		t.Errorf("a plain record should keep the existing row")
	}
	off, err := s.Onboarding.Record([]OnboardingEntry{{Tour: "tutorials", TourVersion: 1, Outcome: domain.OnboardingSkipped, Replace: true}})
	if err != nil {
		t.Fatalf("replace: %v", err)
	}
	if off[0].ID == on[0].ID || off[0].Outcome != domain.OnboardingSkipped {
		t.Errorf("replace = %+v, want a new skipped row", off[0])
	}
	all, _ := s.Onboarding.List()
	if len(all) != 1 || all[0].ID != off[0].ID {
		t.Errorf("live rows = %+v, want only the replacement", all)
	}
	if old, _ := s.Onboarding.GetAny(on[0].ID); old.DeletedAt == nil || !old.Dirty {
		t.Errorf("the replaced row should be a dirty tombstone: %+v", old)
	}
}
