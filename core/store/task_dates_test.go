//go:build !js

package store

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"companion/core/domain"
)

func TestTaskStartDeadlineAndReminders(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	start := time.Date(2026, 10, 1, 13, 0, 0, 0, time.UTC)
	deadline := time.Date(2026, 10, 10, 21, 0, 0, 0, time.UTC)
	at := time.Date(2026, 10, 2, 9, 0, 0, 0, time.FixedZone("EDT", -4*3600))
	created, err := s.Tasks.Create(CreateTaskInput{
		Title: "Quarterly report", StartAt: &start, DueAt: &deadline,
		Reminders: []domain.Reminder{{At: &at}, {Before: "p1d"}, {Before: "P1M"}, {Before: "P1D"}},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// Normalized on write: canonical leads, duplicates dropped, leads longest-first, then instants.
	wantReminders := `[{"before":"P1M"},{"before":"P1D"},{"at":"2026-10-02T13:00:00Z"}]`
	if got := remindersJSON(created.Reminders); got != wantReminders {
		t.Errorf("created reminders = %s, want %s", got, wantReminders)
	}

	got, err := s.Tasks.Get(created.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.StartAt == nil || !got.StartAt.Equal(start) || got.DueAt == nil || !got.DueAt.Equal(deadline) {
		t.Errorf("dates round-trip = start %v deadline %v", got.StartAt, got.DueAt)
	}
	if remindersJSON(got.Reminders) != wantReminders {
		t.Errorf("stored reminders = %s, want %s", remindersJSON(got.Reminders), wantReminders)
	}

	// Replace the reminder list wholesale; the dates are untouched.
	week := []domain.Reminder{{Before: "P1W"}}
	updated, err := s.Tasks.Update(created.ID, UpdateTaskInput{Reminders: &week})
	if err != nil {
		t.Fatalf("update reminders: %v", err)
	}
	if remindersJSON(updated.Reminders) != `[{"before":"P1W"}]` || updated.StartAt == nil || updated.DueAt == nil {
		t.Errorf("after replacing reminders: %+v", updated)
	}

	// An update that doesn't mention reminders leaves them alone.
	title := "Q3 report"
	if updated, err = s.Tasks.Update(created.ID, UpdateTaskInput{Title: &title}); err != nil {
		t.Fatalf("retitle: %v", err)
	}
	if remindersJSON(updated.Reminders) != `[{"before":"P1W"}]` {
		t.Errorf("retitling changed reminders: %s", remindersJSON(updated.Reminders))
	}

	// An empty list clears them; ClearStartAt clears the start.
	none := []domain.Reminder{}
	if updated, err = s.Tasks.Update(created.ID, UpdateTaskInput{Reminders: &none, ClearStartAt: true}); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if len(updated.Reminders) != 0 || updated.StartAt != nil || updated.DueAt == nil {
		t.Errorf("after clearing: reminders %v start %v deadline %v", updated.Reminders, updated.StartAt, updated.DueAt)
	}
	if got, _ := s.Tasks.Get(created.ID); got.Reminders == nil {
		t.Error("a task with no reminders should read back an empty list, not nil")
	}
	if b, _ := json.Marshal(updated); !strings.Contains(string(b), `"reminders":[]`) {
		t.Errorf("a task with no reminders should serialize reminders as [], got %s", b)
	}

	// Invalid reminders are rejected on both write paths.
	bad := []domain.Reminder{{Before: "whenever"}}
	if _, err := s.Tasks.Create(CreateTaskInput{Title: "x", Reminders: bad}); !errors.Is(err, domain.ErrInvalidTask) {
		t.Errorf("create with a bad reminder: %v", err)
	}
	if _, err := s.Tasks.Update(created.ID, UpdateTaskInput{Reminders: &bad}); !errors.Is(err, domain.ErrInvalidTask) {
		t.Errorf("update with a bad reminder: %v", err)
	}
}

func TestTaskApplyAndDiffCoverNewFields(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	start := time.Date(2026, 10, 1, 13, 0, 0, 0, time.UTC)
	remote := &domain.Task{
		ID: "remote-1", Title: "From another device", Status: domain.TaskOpen, StartAt: &start,
		Reminders: []domain.Reminder{{Before: "P3D"}},
		CreatedAt: clk.t, UpdatedAt: clk.t, Version: 4,
	}
	if err := s.Tasks.Apply(remote); err != nil {
		t.Fatalf("apply: %v", err)
	}
	got, err := s.Tasks.GetAny("remote-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.StartAt == nil || !got.StartAt.Equal(start) || remindersJSON(got.Reminders) != `[{"before":"P3D"}]` || got.Dirty {
		t.Errorf("applied task = %+v", got)
	}

	// A peer (or an older client) that sends no reminders stores an empty list.
	remote.Reminders = nil
	remote.Version = 5
	if err := s.Tasks.Apply(remote); err != nil {
		t.Fatalf("apply without reminders: %v", err)
	}
	if got, _ = s.Tasks.GetAny("remote-1"); got.Reminders == nil || len(got.Reminders) != 0 {
		t.Errorf("reminders after a nil apply = %#v, want []", got.Reminders)
	}

	base := *got
	moved := base
	later := start.Add(time.Hour)
	moved.StartAt = &later
	if !s.Tasks.MeaningfulDiff(&base, &moved) {
		t.Error("a moved start should be a meaningful diff")
	}
	reminded := base
	reminded.Reminders = []domain.Reminder{{Before: "P1D"}}
	if !s.Tasks.MeaningfulDiff(&base, &reminded) {
		t.Error("a changed reminder list should be a meaningful diff")
	}
	same := base
	same.Reminders = []domain.Reminder{}
	if s.Tasks.MeaningfulDiff(&base, &same) {
		t.Error("nil and empty reminder lists should not differ")
	}
}

// TestMigrationMovesRemindAtIntoReminders runs the schema up to the last pre-reminders
// migration, stores tasks the old way, then applies the rest: each single remind_at must
// become the first entry of reminders_json, and the old column must be gone.
func TestMigrationMovesRemindAtIntoReminders(t *testing.T) {
	d, err := openNativeDriver(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	if _, err := d.Exec(`CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));`); err != nil {
		t.Fatal(err)
	}
	names, err := migrationNames()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		if versionOf(name) >= "0024" {
			break
		}
		body, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if err := applyMigration(d, name, versionOf(name), string(body)); err != nil {
			t.Fatalf("apply %s: %v", name, err)
		}
	}
	for _, row := range []struct{ id, remind any }{{"with-reminder", "2026-10-09T13:00:00Z"}, {"without", nil}} {
		if _, err := d.Exec(`INSERT INTO tasks (id, title, status, remind_at, created_at, updated_at, version, dirty)
			VALUES (?, 'Old task', 'open', ?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', 3, 0);`, row.id, row.remind); err != nil {
			t.Fatalf("insert %v: %v", row.id, err)
		}
	}

	if err := migrate(d); err != nil {
		t.Fatalf("migrate to head: %v", err)
	}
	s, err := New(d, &fixedClock{t: time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)})
	if err != nil {
		t.Fatal(err)
	}

	with, err := s.Tasks.GetAny("with-reminder")
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 10, 9, 13, 0, 0, 0, time.UTC)
	if len(with.Reminders) != 1 || with.Reminders[0].At == nil || !with.Reminders[0].At.Equal(want) {
		t.Errorf("migrated reminders = %+v, want one at %v", with.Reminders, want)
	}
	if with.Dirty || with.Version != 3 {
		t.Errorf("migration must not dirty rows or bump versions: dirty %v version %d", with.Dirty, with.Version)
	}
	without, err := s.Tasks.GetAny("without")
	if err != nil {
		t.Fatal(err)
	}
	if len(without.Reminders) != 0 {
		t.Errorf("a task with no reminder should migrate to [], got %+v", without.Reminders)
	}
	if rows, err := d.Query(`SELECT remind_at FROM tasks;`); err == nil {
		rows.Close()
		t.Error("remind_at should be dropped")
	}
}
