package domain

import (
	"testing"
	"time"
)

func TestValidateRepeatRule(t *testing.T) {
	daily := "FREQ=DAILY"
	prefixed := "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"
	bad := "FREQ=NONSENSE"
	empty := "   "

	if err := ValidateRepeatRule(nil); err != nil {
		t.Errorf("nil rule should be valid (non-repeating): %v", err)
	}
	if err := ValidateRepeatRule(&empty); err != nil {
		t.Errorf("blank rule should be valid (non-repeating): %v", err)
	}
	if err := ValidateRepeatRule(&daily); err != nil {
		t.Errorf("FREQ=DAILY should be valid: %v", err)
	}
	if err := ValidateRepeatRule(&prefixed); err != nil {
		t.Errorf("prefixed weekly rule should be valid: %v", err)
	}
	if err := ValidateRepeatRule(&bad); err == nil {
		t.Error("nonsense freq should be invalid")
	}
}

func TestNextOccurrence(t *testing.T) {
	anchor := time.Date(2026, 7, 6, 9, 0, 0, 0, time.UTC) // a Monday, 09:00
	// Weekly on Mondays. From mid-week Wednesday, next is the following Monday.
	after := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	next, err := NextOccurrence("FREQ=WEEKLY;BYDAY=MO", anchor, after)
	if err != nil {
		t.Fatalf("next: %v", err)
	}
	if next == nil {
		t.Fatal("expected a next occurrence")
	}
	want := time.Date(2026, 7, 13, 9, 0, 0, 0, time.UTC)
	if !next.Equal(want) {
		t.Errorf("next = %v, want %v", next, want)
	}
}

func TestNextOccurrenceExhausted(t *testing.T) {
	anchor := time.Date(2026, 7, 6, 9, 0, 0, 0, time.UTC)
	// Only two occurrences ever; asking after the second yields nil.
	after := time.Date(2026, 7, 8, 0, 0, 0, 0, time.UTC)
	next, err := NextOccurrence("FREQ=DAILY;COUNT=2", anchor, after)
	if err != nil {
		t.Fatalf("next: %v", err)
	}
	if next != nil {
		t.Errorf("expected nil after COUNT exhausted, got %v", next)
	}
}

func TestLatestOccurrence(t *testing.T) {
	anchor := time.Date(2026, 7, 6, 9, 0, 0, 0, time.UTC) // Monday
	rule := "FREQ=DAILY"

	// Before the schedule starts, there is no current occurrence.
	if got, err := LatestOccurrence(rule, anchor, anchor.Add(-time.Hour)); err != nil || got != nil {
		t.Errorf("before start: got %v, %v; want nil, nil", got, err)
	}
	// Exactly at the anchor, the current occurrence is the anchor (inclusive).
	if got, err := LatestOccurrence(rule, anchor, anchor); err != nil || got == nil || !got.Equal(anchor) {
		t.Errorf("at anchor: got %v, %v; want %v", got, err, anchor)
	}
	// Two and a half days in, the current occurrence is day 2's — not day 3's (future).
	at := anchor.AddDate(0, 0, 2).Add(12 * time.Hour)
	want := anchor.AddDate(0, 0, 2)
	if got, err := LatestOccurrence(rule, anchor, at); err != nil || got == nil || !got.Equal(want) {
		t.Errorf("mid-day-2: got %v, %v; want %v", got, err, want)
	}
}

func TestIsRepeatSeed(t *testing.T) {
	rule := "FREQ=DAILY"
	seedID := "seed-1"
	blank := ""
	cases := []struct {
		name string
		task Task
		want bool
	}{
		{"seed", Task{RepeatRule: &rule}, true},
		{"occurrence", Task{RepeatSeedID: &seedID}, false},
		{"occurrence with rule copied (defensive)", Task{RepeatRule: &rule, RepeatSeedID: &seedID}, false},
		{"one-off", Task{}, false},
		{"blank rule", Task{RepeatRule: &blank}, false},
	}
	for _, tc := range cases {
		if got := tc.task.IsRepeatSeed(); got != tc.want {
			t.Errorf("%s: IsRepeatSeed = %v, want %v", tc.name, got, tc.want)
		}
	}
}
