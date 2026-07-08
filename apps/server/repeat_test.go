package main

import (
	"testing"
	"time"

	"companion/core/domain"
	"companion/core/store"
)

// countOccurrences returns how many live occurrence rows of seedID a client holds, asserting
// each is well-formed (points at the seed, carries no rule of its own, has a due date).
func countOccurrences(t *testing.T, c *client, seedID string) int {
	t.Helper()
	list, err := c.store.Tasks.List()
	if err != nil {
		t.Fatalf("list tasks: %v", err)
	}
	n := 0
	for _, task := range list {
		if task.RepeatSeedID == nil || *task.RepeatSeedID != seedID {
			continue
		}
		n++
		if task.RepeatRule != nil {
			t.Errorf("occurrence %s should not carry its own repeat rule", task.ID)
		}
		if task.DueAt == nil {
			t.Errorf("occurrence %s should have a due date", task.ID)
		}
	}
	return n
}

// registerAt registers a user with the server clock temporarily pinned to `at`, so the
// issued access token (1h TTL) stays valid across the deliberate clock advances these
// just-in-time tests perform. It restores the clock afterward. The auth check only validates
// expiry, so a token "issued in the future" is fine when used at an earlier test instant.
func registerAt(t *testing.T, srv *Server, clk *testClock, baseURL, email, pw string, at time.Time) string {
	t.Helper()
	prev := clk.t
	clk.t = at
	token := register(t, baseURL, email, pw)
	clk.t = prev
	return token
}

func seedInList(t *testing.T, c *client, seedID string) bool {
	t.Helper()
	list, err := c.store.Tasks.List()
	if err != nil {
		t.Fatalf("list tasks: %v", err)
	}
	for _, task := range list {
		if task.ID == seedID {
			return true
		}
	}
	return false
}

// Creating a seed whose first occurrence is already due generates exactly one occurrence —
// the one due now — not a batch of future ones. B pulls it down; the seed stays hidden from
// the actionable list but present as a definition.
func TestRepeatCreatesDueOccurrence(t *testing.T) {
	ts, srv := newServerAPI(t)
	t0 := time.Date(2026, 7, 6, 9, 0, 0, 0, time.UTC)
	srv.clock = &testClock{t: t0}

	token := register(t, ts.URL, "due@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	rule := "FREQ=DAILY"
	seed, err := a.store.Tasks.Create(store.CreateTaskInput{Title: "Water plants", DueAt: &t0, RepeatRule: &rule})
	if err != nil {
		t.Fatalf("create seed: %v", err)
	}
	a.engine.Sync()
	b.engine.Sync()

	if got := countOccurrences(t, a, seed.ID); got != 1 {
		t.Errorf("A occurrences = %d, want exactly 1 (today's, nothing ahead)", got)
	}
	if got := countOccurrences(t, b, seed.ID); got != 1 {
		t.Errorf("B occurrences = %d, want 1", got)
	}
	if seedInList(t, b, seed.ID) {
		t.Error("seed should not appear in B's actionable list")
	}
	seeds, err := b.store.Tasks.ListSeeds()
	if err != nil {
		t.Fatalf("B list seeds: %v", err)
	}
	if len(seeds) != 1 || seeds[0].ID != seed.ID {
		t.Errorf("B should hold exactly the seed as a definition, got %+v", seeds)
	}
}

// A seed whose first occurrence is still in the future generates nothing until that instant
// arrives — repeats are never created ahead of time.
func TestRepeatNothingAheadOfTime(t *testing.T) {
	ts, srv := newServerAPI(t)
	t0 := time.Date(2026, 7, 6, 9, 0, 0, 0, time.UTC)
	clk := &testClock{t: t0}
	srv.clock = clk

	token := registerAt(t, srv, clk, ts.URL, "future@b.co", "password", t0.AddDate(1, 0, 0))
	a := newClient(t, ts.URL, token, "devA")

	due := t0.AddDate(0, 0, 1) // tomorrow
	rule := "FREQ=DAILY"
	seed, err := a.store.Tasks.Create(store.CreateTaskInput{Title: "Stretch", DueAt: &due, RepeatRule: &rule})
	if err != nil {
		t.Fatalf("create seed: %v", err)
	}
	a.engine.Sync()
	if got := countOccurrences(t, a, seed.ID); got != 0 {
		t.Fatalf("A occurrences before due = %d, want 0 (nothing ahead of time)", got)
	}

	// Advance to the due day and run a sweep: now the first occurrence exists.
	clk.t = due
	if _, err := srv.MaterializeAllRepeats(); err != nil {
		t.Fatalf("materialize: %v", err)
	}
	a.engine.Sync()
	if got := countOccurrences(t, a, seed.ID); got != 1 {
		t.Errorf("A occurrences after due arrives = %d, want 1", got)
	}
}

// The minute sweep generates each day's occurrence as its day arrives: one occurrence per
// day, appearing on that day and never before.
func TestRepeatGeneratesJustInTime(t *testing.T) {
	ts, srv := newServerAPI(t)
	t0 := time.Date(2026, 7, 6, 9, 0, 0, 0, time.UTC)
	clk := &testClock{t: t0}
	srv.clock = clk

	token := registerAt(t, srv, clk, ts.URL, "jit@b.co", "password", t0.AddDate(1, 0, 0))
	a := newClient(t, ts.URL, token, "devA")

	rule := "FREQ=DAILY"
	seed, err := a.store.Tasks.Create(store.CreateTaskInput{Title: "Journal", DueAt: &t0, RepeatRule: &rule})
	if err != nil {
		t.Fatalf("create seed: %v", err)
	}
	a.engine.Sync()
	if got := countOccurrences(t, a, seed.ID); got != 1 {
		t.Fatalf("day 0 occurrences = %d, want 1", got)
	}

	// Each following day's sweep adds exactly that day's occurrence — never more, never ahead.
	for day := 1; day <= 2; day++ {
		clk.t = t0.AddDate(0, 0, day)
		if _, err := srv.MaterializeAllRepeats(); err != nil {
			t.Fatalf("materialize day %d: %v", day, err)
		}
		a.engine.Sync()
		if got := countOccurrences(t, a, seed.ID); got != day+1 {
			t.Errorf("after day %d occurrences = %d, want %d", day, got, day+1)
		}
	}
}

// Trashing a seed stops generation but leaves already-created occurrences in place (they are
// ordinary tasks the user still owns).
func TestRepeatSeedTrashStopsGeneration(t *testing.T) {
	ts, srv := newServerAPI(t)
	t0 := time.Date(2026, 7, 6, 9, 0, 0, 0, time.UTC)
	clk := &testClock{t: t0}
	srv.clock = clk

	token := registerAt(t, srv, clk, ts.URL, "seedtrash@b.co", "password", t0.AddDate(1, 0, 0))
	a := newClient(t, ts.URL, token, "devA")

	rule := "FREQ=DAILY"
	seed, err := a.store.Tasks.Create(store.CreateTaskInput{Title: "Meditate", DueAt: &t0, RepeatRule: &rule})
	if err != nil {
		t.Fatalf("create seed: %v", err)
	}
	a.engine.Sync()
	if got := countOccurrences(t, a, seed.ID); got != 1 {
		t.Fatalf("occurrences = %d, want 1", got)
	}

	a.clk.t = base.Add(time.Hour)
	if err := a.store.Tasks.Trash(seed.ID); err != nil {
		t.Fatalf("trash seed: %v", err)
	}
	a.engine.Sync()

	// Days pass; the trashed seed generates nothing new, and its one occurrence remains.
	clk.t = t0.AddDate(0, 0, 3)
	if _, err := srv.MaterializeAllRepeats(); err != nil {
		t.Fatalf("materialize: %v", err)
	}
	a.engine.Sync()
	if got := countOccurrences(t, a, seed.ID); got != 1 {
		t.Errorf("occurrences after seed trash + 3 days = %d, want 1 (no new generation)", got)
	}
}

// An occurrence copies the seed's project membership and its reminder (time-shifted to the
// occurrence's date); generation is timed to the reminder so it can still fire; and the seed
// advances its displayed due/reminder to the generated occurrence (PLAN §6.4/§6.6).
func TestRepeatCopiesReminderAndProject(t *testing.T) {
	ts, srv := newServerAPI(t)
	t0 := time.Date(2026, 7, 6, 8, 0, 0, 0, time.UTC) // the reminder instant (1h before due)
	clk := &testClock{t: t0}
	srv.clock = clk

	token := registerAt(t, srv, clk, ts.URL, "copy@b.co", "password", t0.AddDate(1, 0, 0))
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	area, _ := a.store.Areas.Create(store.CreateAreaInput{Name: "Home"})
	proj, _ := a.store.Projects.Create(store.CreateProjectInput{AreaID: area.ID, Name: "Chores"})
	due := t0.Add(time.Hour) // due 09:00
	remind := t0             // remind 08:00 (an hour before)
	rule := "FREQ=DAILY"
	seed, err := a.store.Tasks.Create(store.CreateTaskInput{Title: "Water plants", DueAt: &due, RemindAt: &remind, RepeatRule: &rule})
	if err != nil {
		t.Fatalf("create seed: %v", err)
	}
	if _, err := a.store.ProjectMembers.Add(proj.ID, "task", seed.ID); err != nil {
		t.Fatalf("add member: %v", err)
	}
	a.engine.Sync()
	b.engine.Sync()

	// Exactly one occurrence, due at 09:00 with its reminder shifted to 08:00.
	occ := onlyOccurrence(t, b, seed.ID)
	if occ.DueAt == nil || !occ.DueAt.Equal(due) {
		t.Errorf("occurrence due = %v, want %v", occ.DueAt, due)
	}
	if occ.RemindAt == nil || !occ.RemindAt.Equal(remind) {
		t.Errorf("occurrence remind = %v, want %v", occ.RemindAt, remind)
	}
	// It inherits the seed's project membership.
	members, _ := b.store.ProjectMembers.ListForEntity("task", occ.ID)
	if len(members) != 1 || members[0].ProjectID != proj.ID {
		t.Errorf("occurrence memberships = %+v, want project %s", members, proj.ID)
	}
	// The seed advanced its displayed due/reminder to the generated occurrence.
	seedB, err := b.store.Tasks.GetAny(seed.ID)
	if err != nil {
		t.Fatalf("get seed: %v", err)
	}
	if seedB.DueAt == nil || !seedB.DueAt.Equal(due) || seedB.RemindAt == nil || !seedB.RemindAt.Equal(remind) {
		t.Errorf("seed dates = due %v remind %v, want %v / %v", seedB.DueAt, seedB.RemindAt, due, remind)
	}
}

// onlyOccurrence returns the single live occurrence of a seed on a client, failing otherwise.
func onlyOccurrence(t *testing.T, c *client, seedID string) *domain.Task {
	t.Helper()
	list, err := c.store.Tasks.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	var found []*domain.Task
	for _, task := range list {
		if task.RepeatSeedID != nil && *task.RepeatSeedID == seedID {
			found = append(found, task)
		}
	}
	if len(found) != 1 {
		t.Fatalf("expected exactly 1 occurrence, got %d", len(found))
	}
	return found[0]
}

// A sub-daily cadence never floods the table: a sweep creates only the current occurrence,
// so even after a huge time jump (thousands of 5-minute instants now overdue) exactly one
// new row is created — the one due now. Missed intermediate instants are simply skipped.
func TestRepeatSubDailyOnePerSweep(t *testing.T) {
	ts, srv := newServerAPI(t)
	t0 := time.Date(2026, 7, 6, 9, 0, 0, 0, time.UTC)
	clk := &testClock{t: t0}
	srv.clock = clk

	token := registerAt(t, srv, clk, ts.URL, "subdaily@b.co", "password", t0.AddDate(1, 0, 0))
	a := newClient(t, ts.URL, token, "devA")

	rule := "FREQ=MINUTELY;INTERVAL=5"
	seed, err := a.store.Tasks.Create(store.CreateTaskInput{Title: "Ping", DueAt: &t0, RepeatRule: &rule})
	if err != nil {
		t.Fatalf("create seed: %v", err)
	}
	a.engine.Sync() // creates the one occurrence due at t0

	clk.t = t0.Add(10 * 24 * time.Hour)
	if _, err := srv.MaterializeAllRepeats(); err != nil {
		t.Fatalf("materialize: %v", err)
	}
	a.engine.Sync()
	if got := countOccurrences(t, a, seed.ID); got != 2 {
		t.Errorf("occurrences after a 10-day jump = %d, want 2 (t0 + the one due now)", got)
	}
}
