//go:build !js

package store

import (
	"testing"
	"time"

	"companion/core/domain"
)

func TestNotificationReadsMarkAndList(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	fire := time.Date(2026, 7, 6, 9, 0, 0, 0, time.UTC)
	first, err := s.NotificationReads.MarkRead("task-1", fire)
	if err != nil {
		t.Fatalf("mark read: %v", err)
	}
	if first.ID != domain.NotificationReadID("task-1", fire) {
		t.Errorf("id = %q, want deterministic id", first.ID)
	}
	if !first.Dirty {
		t.Error("fresh read should be dirty (pending push)")
	}

	// Idempotent: marking again keeps the existing row (no new dirty write).
	again, err := s.NotificationReads.MarkRead("task-1", fire)
	if err != nil {
		t.Fatalf("mark read again: %v", err)
	}
	if again.ID != first.ID || !again.ReadAt.Equal(first.ReadAt) {
		t.Errorf("re-mark changed the row: %+v vs %+v", again, first)
	}

	ids, err := s.NotificationReads.ReadIDs(fire.Add(-time.Hour))
	if err != nil {
		t.Fatalf("read ids: %v", err)
	}
	if !ids[first.ID] || len(ids) != 1 {
		t.Errorf("read ids = %v, want {%s}", ids, first.ID)
	}

	// A fire older than `since` is excluded from the join set.
	ids, err = s.NotificationReads.ReadIDs(fire.Add(time.Hour))
	if err != nil {
		t.Fatalf("read ids (later since): %v", err)
	}
	if len(ids) != 0 {
		t.Errorf("read ids = %v, want empty", ids)
	}
}

func TestNotificationReadsSyncSurface(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	fire := time.Date(2026, 7, 6, 9, 0, 0, 0, time.UTC)
	n, err := s.NotificationReads.MarkRead("task-1", fire)
	if err != nil {
		t.Fatalf("mark read: %v", err)
	}

	dirty, err := s.NotificationReads.Dirty()
	if err != nil {
		t.Fatalf("dirty: %v", err)
	}
	if len(dirty) != 1 || dirty[0].ID != n.ID {
		t.Fatalf("dirty = %+v, want the fresh read", dirty)
	}

	if err := s.NotificationReads.MarkPushed(n.ID, 3); err != nil {
		t.Fatalf("mark pushed: %v", err)
	}
	got, err := s.NotificationReads.GetAny(n.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Dirty || got.Version != 3 {
		t.Errorf("after push: dirty=%v version=%d, want clean v3", got.Dirty, got.Version)
	}

	// Apply an incoming server row for a fire this device never saw locally.
	otherFire := fire.Add(30 * time.Minute)
	server := &domain.NotificationRead{
		ID: domain.NotificationReadID("task-2", otherFire), TaskID: "task-2", FireAt: otherFire,
		ReadAt: clk.t, CreatedAt: clk.t, UpdatedAt: clk.t, Version: 1,
	}
	if err := s.NotificationReads.Apply(server); err != nil {
		t.Fatalf("apply: %v", err)
	}
	applied, err := s.NotificationReads.GetAny(server.ID)
	if err != nil {
		t.Fatalf("get applied: %v", err)
	}
	if applied.Dirty || applied.Version != 1 || applied.TaskID != "task-2" {
		t.Errorf("applied row = %+v, want clean server copy", applied)
	}

	// Read receipts agree by construction: only alive-vs-deleted is a meaningful diff.
	other := *applied
	if s.NotificationReads.MeaningfulDiff(applied, &other) {
		t.Error("identical rows should not meaningfully differ")
	}
	dt := clk.t
	other.DeletedAt = &dt
	if !s.NotificationReads.MeaningfulDiff(applied, &other) {
		t.Error("alive vs deleted should meaningfully differ")
	}
}
