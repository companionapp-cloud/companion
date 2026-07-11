package calendar

import (
	"strings"
	"testing"
	"time"
)

// fixtureICS has one single event and one weekly recurring event (COUNT=3).
const fixtureICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Companion//Test//EN
BEGIN:VEVENT
UID:single-1
SUMMARY:Kickoff
LOCATION:Room 1
DTSTART:20260704T090000Z
DTEND:20260704T100000Z
END:VEVENT
BEGIN:VEVENT
UID:weekly-1
SUMMARY:Standup
DTSTART:20260706T140000Z
DTEND:20260706T141500Z
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3
END:VEVENT
END:VCALENDAR`

func TestParseAndExpand(t *testing.T) {
	now := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	events, err := ParseAndExpand(strings.NewReader(fixtureICS), "feed-1", now)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(events) != 4 {
		t.Fatalf("expected 4 occurrences (1 single + 3 weekly), got %d", len(events))
	}

	byTitle := map[string]int{}
	for _, e := range events {
		byTitle[e.Title]++
		if !e.Dirty {
			t.Errorf("expanded event should be dirty for push: %+v", e)
		}
		if e.Title == "Kickoff" {
			if e.EndsAt == nil || e.Location == nil || *e.Location != "Room 1" {
				t.Errorf("single event missing end/location: %+v", e)
			}
		}
	}
	if byTitle["Kickoff"] != 1 || byTitle["Standup"] != 3 {
		t.Fatalf("unexpected title counts: %v", byTitle)
	}

	// Ids are deterministic across parses (idempotent upserts + cross-device convergence).
	again, _ := ParseAndExpand(strings.NewReader(fixtureICS), "feed-1", now)
	for i := range events {
		if events[i].ID != again[i].ID {
			t.Fatalf("event id not deterministic: %s vs %s", events[i].ID, again[i].ID)
		}
	}
}

func TestNormalizeFeedURL(t *testing.T) {
	cases := map[string]string{
		"webcal://example.com/f.ics":  "https://example.com/f.ics",
		"webcals://example.com/f.ics": "https://example.com/f.ics",
		"https://example.com/f.ics":   "https://example.com/f.ics",
		"  http://x.test/a ":          "http://x.test/a",
	}
	for in, want := range cases {
		if got := NormalizeFeedURL(in); got != want {
			t.Errorf("NormalizeFeedURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestExpandHonorsExdate(t *testing.T) {
	const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:weekly-ex
SUMMARY:Weekly
DTSTART:20260706T140000Z
DTEND:20260706T141500Z
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3
EXDATE:20260713T140000Z
END:VEVENT
END:VCALENDAR`
	now := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	events, err := ParseAndExpand(strings.NewReader(ics), "feed-ex", now)
	if err != nil {
		t.Fatal(err)
	}
	// 3 by COUNT minus 1 excluded = 2.
	if len(events) != 2 {
		t.Fatalf("expected 2 occurrences after EXDATE, got %d", len(events))
	}
	for _, e := range events {
		if e.StartsAt.Equal(time.Date(2026, 7, 13, 14, 0, 0, 0, time.UTC)) {
			t.Fatal("excluded instance should not appear")
		}
	}
}

func TestChanged(t *testing.T) {
	now := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	a, _ := ParseAndExpand(strings.NewReader(fixtureICS), "f", now)
	b, _ := ParseAndExpand(strings.NewReader(fixtureICS), "f", now)
	if Changed(a[0], b[0]) {
		t.Fatal("identical expansions must not be reported as changed (avoids sync churn)")
	}
	b[0].Title = "Different"
	if !Changed(a[0], b[0]) {
		t.Fatal("a changed title must be detected")
	}
}
