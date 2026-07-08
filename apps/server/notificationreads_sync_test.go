package main

import (
	"testing"
	"time"

	"companion/core/domain"
)

// A notification marked read on device A reads as read on device B (PLAN §6.4). The
// deterministic row id is the crux: both devices marking the same fire independently must
// converge on one row instead of duplicating or conflicting.
func TestNotificationReadsSync(t *testing.T) {
	ts := newServer(t)
	token := register(t, ts.URL, "reads@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	fire := base.Add(-2 * time.Hour)
	readA, err := a.store.NotificationReads.MarkRead("task-1", fire)
	if err != nil {
		t.Fatalf("A mark read: %v", err)
	}
	syncAll(t, a, b)

	// B sees the same receipt, clean, with a server version.
	gotB, err := b.store.NotificationReads.GetAny(readA.ID)
	if err != nil {
		t.Fatalf("B receipt: %v", err)
	}
	if gotB.Dirty || gotB.Version == 0 || gotB.TaskID != "task-1" {
		t.Errorf("B receipt = %+v, want clean synced copy", gotB)
	}
	ids, err := b.store.NotificationReads.ReadIDs(fire.Add(-time.Hour))
	if err != nil || !ids[readA.ID] {
		t.Errorf("B read ids = %v (err %v), want %s", ids, err, readA.ID)
	}

	// Both devices marking the same fire read (offline race) converge on one row.
	if _, err := b.store.NotificationReads.MarkRead("task-2", fire); err != nil {
		t.Fatalf("B mark read task-2: %v", err)
	}
	if _, err := a.store.NotificationReads.MarkRead("task-2", fire); err != nil {
		t.Fatalf("A mark read task-2: %v", err)
	}
	syncAll(t, a, b)

	id2 := domain.NotificationReadID("task-2", fire)
	gotA, errA := a.store.NotificationReads.GetAny(id2)
	gotB2, errB := b.store.NotificationReads.GetAny(id2)
	if errA != nil || errB != nil {
		t.Fatalf("post-race receipts: A err %v, B err %v", errA, errB)
	}
	if gotA.Dirty || gotB2.Dirty {
		t.Errorf("receipts should be clean after convergence: A %+v, B %+v", gotA, gotB2)
	}
	if gotA.Version != gotB2.Version {
		t.Errorf("versions diverged: A v%d, B v%d", gotA.Version, gotB2.Version)
	}
}
