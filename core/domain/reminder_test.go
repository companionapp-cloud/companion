package domain

import (
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func ptrTime(t time.Time) *time.Time { return &t }

func TestParseLead(t *testing.T) {
	cases := []struct {
		in   string
		want Lead
		str  string
	}{
		{"P1D", Lead{1, LeadDays}, "P1D"},
		{"p3d", Lead{3, LeadDays}, "P3D"},
		{" P1W ", Lead{1, LeadWeeks}, "P1W"},
		{"P2W", Lead{2, LeadWeeks}, "P2W"},
		{"P1M", Lead{1, LeadMonths}, "P1M"},
		{"PT1H", Lead{1, LeadHours}, "PT1H"},
		{"PT30M", Lead{30, LeadMinutes}, "PT30M"},
		// Every zero lead is the one "at the deadline" lead.
		{"PT0M", Lead{0, LeadMinutes}, "PT0M"},
		{"P0D", Lead{0, LeadMinutes}, "PT0M"},
		{"PT0H", Lead{0, LeadMinutes}, "PT0M"},
	}
	for _, c := range cases {
		got, err := ParseLead(c.in)
		if err != nil {
			t.Errorf("ParseLead(%q): %v", c.in, err)
			continue
		}
		if got != c.want || got.String() != c.str {
			t.Errorf("ParseLead(%q) = %+v (%s), want %+v (%s)", c.in, got, got.String(), c.want, c.str)
		}
	}
	for _, bad := range []string{"", "1D", "P", "P1", "P1D2H", "P1DT1H", "PT1D", "P1H", "P-1D", "P1.5D", "P1Y", "P1001D"} {
		if _, err := ParseLead(bad); err == nil {
			t.Errorf("ParseLead(%q) should fail", bad)
		}
	}
}

func TestLeadBefore(t *testing.T) {
	deadline := time.Date(2026, 10, 10, 21, 0, 0, 0, time.UTC)
	cases := []struct {
		lead string
		want time.Time
	}{
		{"PT0M", deadline},
		{"PT30M", time.Date(2026, 10, 10, 20, 30, 0, 0, time.UTC)},
		{"PT2H", time.Date(2026, 10, 10, 19, 0, 0, 0, time.UTC)},
		{"P1D", time.Date(2026, 10, 9, 21, 0, 0, 0, time.UTC)},
		{"P3D", time.Date(2026, 10, 7, 21, 0, 0, 0, time.UTC)},
		{"P1W", time.Date(2026, 10, 3, 21, 0, 0, 0, time.UTC)},
		{"P2W", time.Date(2026, 9, 26, 21, 0, 0, 0, time.UTC)},
		{"P1M", time.Date(2026, 9, 10, 21, 0, 0, 0, time.UTC)},
		{"P12M", time.Date(2025, 10, 10, 21, 0, 0, 0, time.UTC)},
	}
	for _, c := range cases {
		l, err := ParseLead(c.lead)
		if err != nil {
			t.Fatal(err)
		}
		if got := l.Before(deadline); !got.Equal(c.want) {
			t.Errorf("%s before %v = %v, want %v", c.lead, deadline, got, c.want)
		}
	}

	// A month back clamps to the shorter month instead of rolling into the next one.
	month := Lead{1, LeadMonths}
	if got, want := month.Before(time.Date(2026, 3, 31, 17, 0, 0, 0, time.UTC)), time.Date(2026, 2, 28, 17, 0, 0, 0, time.UTC); !got.Equal(want) {
		t.Errorf("a month before Mar 31 = %v, want %v", got, want)
	}
	if got, want := month.Before(time.Date(2028, 3, 31, 17, 0, 0, 0, time.UTC)), time.Date(2028, 2, 29, 17, 0, 0, 0, time.UTC); !got.Equal(want) {
		t.Errorf("a month before Mar 31 in a leap year = %v, want %v", got, want)
	}
	if got, want := month.Before(time.Date(2026, 1, 15, 9, 0, 0, 0, time.UTC)), time.Date(2025, 12, 15, 9, 0, 0, 0, time.UTC); !got.Equal(want) {
		t.Errorf("a month before Jan 15 = %v, want %v", got, want)
	}

	// Leads resolve in UTC whatever zone the deadline was expressed in.
	toronto := time.FixedZone("EDT", -4*3600)
	local := time.Date(2026, 10, 10, 17, 0, 0, 0, toronto)
	if got := (Lead{1, LeadDays}).Before(local); !got.Equal(local.AddDate(0, 0, -1)) || got.Location() != time.UTC {
		t.Errorf("a day before %v = %v", local, got)
	}
}

func TestReminderValidate(t *testing.T) {
	at := time.Date(2026, 10, 9, 13, 0, 0, 0, time.UTC)
	valid := []Reminder{{At: &at}, {Before: "P1D"}, {Before: "PT0M"}}
	for _, r := range valid {
		if err := r.Validate(); err != nil {
			t.Errorf("%+v: %v", r, err)
		}
	}
	invalid := []Reminder{{}, {Before: "  "}, {At: &at, Before: "P1D"}, {Before: "tomorrow"}}
	for _, r := range invalid {
		if err := r.Validate(); !errors.Is(err, ErrInvalidReminder) {
			t.Errorf("%+v should be invalid, got %v", r, err)
		}
	}
}

func TestNormalizeReminders(t *testing.T) {
	later := time.Date(2026, 10, 9, 13, 0, 0, 0, time.UTC)
	earlier := time.Date(2026, 10, 8, 9, 0, 0, 0, time.FixedZone("EDT", -4*3600))
	got, err := NormalizeReminders([]Reminder{
		{At: &later},
		{Before: "p1d"},
		{Before: "P1M"},
		{Before: "P0D"},
		{At: &earlier},
		{Before: "P1D"}, // duplicate once canonicalized
		{At: ptrTime(later.In(time.FixedZone("X", 3600)))}, // same instant, other zone
		{Before: "P2W"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{`{"before":"P1M"}`, `{"before":"P2W"}`, `{"before":"P1D"}`, `{"before":"PT0M"}`,
		`{"at":"2026-10-08T13:00:00Z"}`, `{"at":"2026-10-09T13:00:00Z"}`}
	if len(got) != len(want) {
		t.Fatalf("got %d reminders, want %d: %+v", len(got), len(want), got)
	}
	for i, r := range got {
		b, _ := json.Marshal(r)
		if string(b) != want[i] {
			t.Errorf("reminder %d = %s, want %s", i, b, want[i])
		}
	}

	if out, err := NormalizeReminders(nil); err != nil || out == nil || len(out) != 0 {
		t.Errorf("NormalizeReminders(nil) = %#v, %v; want an empty non-nil list", out, err)
	}
	if _, err := NormalizeReminders([]Reminder{{Before: "soon"}}); !errors.Is(err, ErrInvalidReminder) {
		t.Errorf("an invalid lead should fail normalization, got %v", err)
	}
	many := make([]Reminder, 0, MaxReminders+1)
	for i := 0; i <= MaxReminders; i++ {
		many = append(many, Reminder{Before: Lead{N: i + 1, Unit: LeadHours}.String()})
	}
	if _, err := NormalizeReminders(many); !errors.Is(err, ErrInvalidReminder) {
		t.Errorf("more than %d reminders should fail, got %v", MaxReminders, err)
	}
}

func TestTaskReminderFires(t *testing.T) {
	deadline := time.Date(2026, 10, 10, 21, 0, 0, 0, time.UTC)
	extra := time.Date(2026, 10, 1, 13, 0, 0, 0, time.UTC)
	task := &Task{Reminders: []Reminder{
		{Before: "P1D"},
		{Before: "P1W"},
		{At: &extra},
		{Before: "PT24H"}, // same instant as P1D: fires once
	}}

	// No deadline: only the absolute reminder resolves.
	if got := task.ReminderFires(); len(got) != 1 || !got[0].Equal(extra) {
		t.Fatalf("fires without a deadline = %v, want [%v]", got, extra)
	}

	task.DueAt = &deadline
	got := task.ReminderFires()
	want := []time.Time{
		extra,
		time.Date(2026, 10, 3, 21, 0, 0, 0, time.UTC),
		time.Date(2026, 10, 9, 21, 0, 0, 0, time.UTC),
	}
	if len(got) != len(want) {
		t.Fatalf("fires = %v, want %v", got, want)
	}
	for i := range want {
		if !got[i].Equal(want[i]) {
			t.Errorf("fire %d = %v, want %v", i, got[i], want[i])
		}
	}
}

func TestShiftReminders(t *testing.T) {
	at := time.Date(2026, 10, 9, 13, 0, 0, 0, time.UTC)
	got := ShiftReminders([]Reminder{{Before: "P1D"}, {At: &at}}, 7*24*time.Hour)
	if got[0].Before != "P1D" || got[0].At != nil {
		t.Errorf("a relative reminder should copy as-is, got %+v", got[0])
	}
	if want := at.AddDate(0, 0, 7); got[1].At == nil || !got[1].At.Equal(want) {
		t.Errorf("an absolute reminder should shift to %v, got %+v", want, got[1])
	}
	if !at.Equal(time.Date(2026, 10, 9, 13, 0, 0, 0, time.UTC)) {
		t.Error("ShiftReminders must not mutate its input")
	}
}

func TestParseReminderPhrase(t *testing.T) {
	cases := []struct {
		in   string
		want string // "" means not a relative reminder
	}{
		// The presets, the way people say them.
		{"the day before", "P1D"},
		{"a day before", "P1D"},
		{"day before", "P1D"},
		{"a few days before", "P3D"},
		{"few days before", "P3D"},
		{"the week before", "P1W"},
		{"a week before", "P1W"},
		{"a few weeks before", "P2W"},
		{"a month before", "P1M"},
		{"a month before the deadline", "P1M"},

		// Counts, spelled or numeric, with or without the deadline named.
		{"3 days before", "P3D"},
		{"three days before", "P3D"},
		{"2 weeks before the deadline", "P2W"},
		{"a couple of days before", "P2D"},
		{"several days before", "P3D"},
		{"6 months before", "P6M"},
		{"an hour before", "PT1H"},
		{"2 hours before it's due", "PT2H"},
		{"half an hour before", "PT30M"},
		{"30 minutes before", "PT30M"},
		{"15 mins early", "PT15M"},
		{"1 day in advance", "P1D"},

		// Compact units.
		{"3d before", "P3D"},
		{"2w before", "P2W"},
		{"30m before", "PT30M"},
		{"1mo before", "P1M"},
		{"2 hrs before", "PT2H"},

		// At the deadline.
		{"at the deadline", "PT0M"},
		{"at deadline", "PT0M"},
		{"when it's due", "PT0M"},
		{"when due", "PT0M"},

		// Noise the input field may carry.
		{"  Remind me   a WEEK before. ", "P1W"},

		// Not relative reminders: absolute times belong to the date parser.
		{"tomorrow at 9am", ""},
		{"in 3 days", ""},
		{"3 days", ""},
		{"next friday", ""},
		{"half a day before", ""},
		{"some days before", ""},
		{"1001 days before", ""},
		{"", ""},
	}
	for _, c := range cases {
		got, ok := ParseReminderPhrase(c.in)
		switch {
		case c.want == "" && ok:
			t.Errorf("ParseReminderPhrase(%q) = %+v, want no match", c.in, got)
		case c.want != "" && (!ok || got.Before != c.want || got.At != nil):
			t.Errorf("ParseReminderPhrase(%q) = %+v, %v; want before %q", c.in, got, ok, c.want)
		}
	}
}

func TestTaskValidateReminders(t *testing.T) {
	task := &Task{ID: "t1", Status: TaskOpen, Reminders: []Reminder{{Before: "P1D"}}}
	if err := task.Validate(); err != nil {
		t.Fatalf("valid task: %v", err)
	}
	task.Reminders = []Reminder{{Before: "whenever"}}
	if err := task.Validate(); !errors.Is(err, ErrInvalidTask) || !errors.Is(err, ErrInvalidReminder) {
		t.Errorf("a bad reminder should fail task validation, got %v", err)
	}
}

func TestRepeatAnchorFallsBackToStart(t *testing.T) {
	created := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	start := time.Date(2026, 9, 7, 13, 0, 0, 0, time.UTC)
	due := time.Date(2026, 9, 11, 21, 0, 0, 0, time.UTC)
	seed := &Task{CreatedAt: created}
	if got := RepeatAnchor(seed); !got.Equal(created) {
		t.Errorf("anchor with no dates = %v, want created %v", got, created)
	}
	seed.StartAt = &start
	if got := RepeatAnchor(seed); !got.Equal(start) {
		t.Errorf("anchor with only a start = %v, want start %v", got, start)
	}
	seed.DueAt = &due
	if got := RepeatAnchor(seed); !got.Equal(due) {
		t.Errorf("anchor with a deadline = %v, want deadline %v", got, due)
	}
}
