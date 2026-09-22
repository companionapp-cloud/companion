package syncserver

import (
	"testing"
	"time"

	"companion/core/domain"
	"companion/core/store"
)

// A tour settled on device A counts as settled on device B, and replaying the tours from
// scratch on B brings them back on A.
func TestOnboardingSync(t *testing.T) {
	ts := newServer(t)
	token := register(t, ts.URL, "tours@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	if _, err := a.store.Onboarding.Record([]store.OnboardingEntry{
		{Tour: "today", TourVersion: 1, Outcome: domain.OnboardingCompleted},
		{Tour: "chat", TourVersion: 1, Outcome: domain.OnboardingSkipped},
	}); err != nil {
		t.Fatalf("A record: %v", err)
	}
	syncAll(t, a, b)

	gotB, err := b.store.Onboarding.List()
	if err != nil {
		t.Fatalf("B list: %v", err)
	}
	if len(gotB) != 2 {
		t.Fatalf("B has %d rows, want 2: %+v", len(gotB), gotB)
	}
	for _, o := range gotB {
		if o.Dirty || o.Version == 0 {
			t.Errorf("B row %+v should be a clean synced copy", o)
		}
	}

	// Both devices settling the same tour offline keep two rows that agree; nothing conflicts.
	a.clk.t = base.Add(time.Hour)
	b.clk.t = base.Add(time.Hour)
	if _, err := a.store.Onboarding.Record([]store.OnboardingEntry{{Tour: "notes", TourVersion: 1, Outcome: domain.OnboardingCompleted}}); err != nil {
		t.Fatalf("A record notes: %v", err)
	}
	if _, err := b.store.Onboarding.Record([]store.OnboardingEntry{{Tour: "notes", TourVersion: 1, Outcome: domain.OnboardingSkipped}}); err != nil {
		t.Fatalf("B record notes: %v", err)
	}
	syncAll(t, a, b)
	for name, c := range map[string]*client{"A": a, "B": b} {
		rows, _ := c.store.Onboarding.List()
		if len(rows) != 4 {
			t.Errorf("%s has %d rows, want 4", name, len(rows))
		}
		if dirty, _ := c.store.Onboarding.Dirty(); len(dirty) != 0 {
			t.Errorf("%s still has dirty rows: %+v", name, dirty)
		}
	}

	// Replaying from scratch on B clears every tour on A too.
	b.clk.t = base.Add(2 * time.Hour)
	if _, err := b.store.Onboarding.Reset(nil); err != nil {
		t.Fatalf("B reset: %v", err)
	}
	syncAll(t, a, b)
	if rows, _ := a.store.Onboarding.List(); len(rows) != 0 {
		t.Errorf("A still has %d settled tours after B's reset: %+v", len(rows), rows)
	}
}
