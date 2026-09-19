package syncserver

import (
	"testing"
	"time"

	"companion/core/domain"
	"companion/core/store"
)

// countOccurrences returns how many live occurrence rows of seedID a client holds, asserting
// each is well-formed (points at the seed, carries no rule of its own, has a deadline — or a
// start, for a start-anchored seed).
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
		if task.DueAt == nil && task.StartAt == nil {
			t.Errorf("occurrence %s should have a deadline or a start", task.ID)
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

// An occurrence copies the seed's project membership and its exact-time reminder (shifted to
// the occurrence's date); generation is timed to the reminder so it can still fire; and the
// seed advances its displayed deadline/reminders to the generated occurrence (PLAN §6.4/§6.6).
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
	seed, err := a.store.Tasks.Create(store.CreateTaskInput{Title: "Water plants", DueAt: &due,
		Reminders: []domain.Reminder{{At: &remind}}, RepeatRule: &rule})
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
	if len(occ.Reminders) != 1 || occ.Reminders[0].At == nil || !occ.Reminders[0].At.Equal(remind) {
		t.Errorf("occurrence reminders = %+v, want one at %v", occ.Reminders, remind)
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
	if seedB.DueAt == nil || !seedB.DueAt.Equal(due) || len(seedB.Reminders) != 1 || !seedB.Reminders[0].At.Equal(remind) {
		t.Errorf("seed dates = due %v reminders %+v, want %v / %v", seedB.DueAt, seedB.Reminders, due, remind)
	}
}

// A lead reminder ("the day before") times generation: each occurrence appears when its
// earliest reminder is due — a day before its deadline — carries the lead unchanged (it
// follows the new deadline), and never earlier than that.
func TestRepeatLeadReminderTimesGeneration(t *testing.T) {
	ts, srv := newServerAPI(t)
	t0 := time.Date(2026, 7, 9, 17, 0, 0, 0, time.UTC) // Thursday 17:00: the first reminder
	clk := &testClock{t: t0}
	srv.clock = clk

	token := registerAt(t, srv, clk, ts.URL, "lead@b.co", "password", t0.AddDate(1, 0, 0))
	a := newClient(t, ts.URL, token, "devA")

	due := t0.AddDate(0, 0, 1) // Friday 17:00
	rule := "FREQ=WEEKLY"
	seed, err := a.store.Tasks.Create(store.CreateTaskInput{Title: "Timesheet", DueAt: &due,
		Reminders: []domain.Reminder{{Before: "P1D"}}, RepeatRule: &rule})
	if err != nil {
		t.Fatalf("create seed: %v", err)
	}
	a.engine.Sync()

	occ := onlyOccurrence(t, a, seed.ID)
	if occ.DueAt == nil || !occ.DueAt.Equal(due) {
		t.Errorf("occurrence deadline = %v, want %v", occ.DueAt, due)
	}
	if len(occ.Reminders) != 1 || occ.Reminders[0].Before != "P1D" {
		t.Errorf("occurrence reminders = %+v, want the P1D lead", occ.Reminders)
	}
	if fires := occ.ReminderFires(); len(fires) != 1 || !fires[0].Equal(t0) {
		t.Errorf("occurrence fires at %v, want %v", fires, t0)
	}

	// Next week's occurrence waits for its own reminder: not a minute before next Thursday 17:00.
	clk.t = t0.AddDate(0, 0, 7).Add(-time.Minute)
	if _, err := srv.MaterializeAllRepeats(); err != nil {
		t.Fatalf("materialize: %v", err)
	}
	a.engine.Sync()
	if got := countOccurrences(t, a, seed.ID); got != 1 {
		t.Fatalf("occurrences just before next reminder = %d, want 1", got)
	}
	clk.t = t0.AddDate(0, 0, 7)
	if _, err := srv.MaterializeAllRepeats(); err != nil {
		t.Fatalf("materialize: %v", err)
	}
	a.engine.Sync()
	if got := countOccurrences(t, a, seed.ID); got != 2 {
		t.Errorf("occurrences at next reminder = %d, want 2", got)
	}
}

// A repeat with a start and no deadline stays start-only: each occurrence gets its start (the
// occurrence instant) and no deadline, is identified by that start (repeat sweeps never
// duplicate it), and appears when it starts.
func TestRepeatStartAnchored(t *testing.T) {
	ts, srv := newServerAPI(t)
	t0 := time.Date(2026, 7, 6, 9, 0, 0, 0, time.UTC) // Monday 09:00
	clk := &testClock{t: t0}
	srv.clock = clk

	token := registerAt(t, srv, clk, ts.URL, "start@b.co", "password", t0.AddDate(1, 0, 0))
	a := newClient(t, ts.URL, token, "devA")

	rule := "FREQ=WEEKLY"
	seed, err := a.store.Tasks.Create(store.CreateTaskInput{Title: "Plan the week", StartAt: &t0, RepeatRule: &rule})
	if err != nil {
		t.Fatalf("create seed: %v", err)
	}
	a.engine.Sync()

	occ := onlyOccurrence(t, a, seed.ID)
	if occ.StartAt == nil || !occ.StartAt.Equal(t0) || occ.DueAt != nil {
		t.Errorf("occurrence start %v deadline %v, want start %v and no deadline", occ.StartAt, occ.DueAt, t0)
	}

	// Sweeping again at the same instant finds the start-keyed occurrence and adds nothing.
	for i := 0; i < 2; i++ {
		if _, err := srv.MaterializeAllRepeats(); err != nil {
			t.Fatalf("materialize: %v", err)
		}
	}
	a.engine.Sync()
	if got := countOccurrences(t, a, seed.ID); got != 1 {
		t.Fatalf("occurrences after repeat sweeps = %d, want 1", got)
	}

	// A week later the next one starts; the seed advanced its start and still has no deadline.
	clk.t = t0.AddDate(0, 0, 7)
	if _, err := srv.MaterializeAllRepeats(); err != nil {
		t.Fatalf("materialize: %v", err)
	}
	a.engine.Sync()
	if got := countOccurrences(t, a, seed.ID); got != 2 {
		t.Errorf("occurrences a week later = %d, want 2", got)
	}
	seedA, err := a.store.Tasks.GetAny(seed.ID)
	if err != nil {
		t.Fatalf("get seed: %v", err)
	}
	if seedA.StartAt == nil || !seedA.StartAt.Equal(clk.t) || seedA.DueAt != nil {
		t.Errorf("seed start %v deadline %v, want start %v and no deadline", seedA.StartAt, seedA.DueAt, clk.t)
	}
}

// With both dates, the deadline anchors the schedule and the start moves with it (keeping its
// distance), and the occurrence appears when it starts — before its deadline or reminders.
func TestRepeatStartMovesWithDeadline(t *testing.T) {
	ts, srv := newServerAPI(t)
	t0 := time.Date(2026, 7, 6, 9, 0, 0, 0, time.UTC) // Monday 09:00: the first start
	clk := &testClock{t: t0}
	srv.clock = clk

	token := registerAt(t, srv, clk, ts.URL, "window@b.co", "password", t0.AddDate(1, 0, 0))
	a := newClient(t, ts.URL, token, "devA")

	due := time.Date(2026, 7, 10, 17, 0, 0, 0, time.UTC) // Friday 17:00
	remind := due.Add(-time.Hour)
	rule := "FREQ=WEEKLY"
	seed, err := a.store.Tasks.Create(store.CreateTaskInput{Title: "Weekly review", StartAt: &t0, DueAt: &due,
		Reminders: []domain.Reminder{{At: &remind}, {Before: "P1D"}}, RepeatRule: &rule})
	if err != nil {
		t.Fatalf("create seed: %v", err)
	}
	a.engine.Sync()

	// It exists from its start on Monday, four days before its deadline.
	occ := onlyOccurrence(t, a, seed.ID)
	if occ.StartAt == nil || !occ.StartAt.Equal(t0) || occ.DueAt == nil || !occ.DueAt.Equal(due) {
		t.Errorf("first occurrence start %v deadline %v, want %v / %v", occ.StartAt, occ.DueAt, t0, due)
	}

	// Next Monday brings the next one: start, deadline and the exact reminder all a week on.
	clk.t = t0.AddDate(0, 0, 7)
	if _, err := srv.MaterializeAllRepeats(); err != nil {
		t.Fatalf("materialize: %v", err)
	}
	a.engine.Sync()
	if got := countOccurrences(t, a, seed.ID); got != 2 {
		t.Fatalf("occurrences next Monday = %d, want 2", got)
	}
	list, _ := a.store.Tasks.List()
	var next *domain.Task
	for _, task := range list {
		if task.RepeatSeedID != nil && *task.RepeatSeedID == seed.ID && task.DueAt != nil && task.DueAt.After(due) {
			next = task
		}
	}
	if next == nil {
		t.Fatal("second occurrence not found")
	}
	wantDue, wantStart, wantRemind := due.AddDate(0, 0, 7), t0.AddDate(0, 0, 7), remind.AddDate(0, 0, 7)
	if !next.DueAt.Equal(wantDue) || next.StartAt == nil || !next.StartAt.Equal(wantStart) {
		t.Errorf("second occurrence start %v deadline %v, want %v / %v", next.StartAt, next.DueAt, wantStart, wantDue)
	}
	fires := next.ReminderFires()
	if len(fires) != 2 || !fires[0].Equal(wantDue.AddDate(0, 0, -1)) || !fires[1].Equal(wantRemind) {
		t.Errorf("second occurrence fires %v, want [%v %v]", fires, wantDue.AddDate(0, 0, -1), wantRemind)
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
