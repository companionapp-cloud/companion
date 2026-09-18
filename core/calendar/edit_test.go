package calendar

import (
	"strings"
	"testing"
	"time"
)

var editNow = time.Date(2026, 9, 18, 12, 0, 0, 0, time.UTC)

func ptr[T any](v T) *T { return &v }

// providerObject is shaped like what iCloud serves: a TZID start, an attendee, an alarm and an
// X- property — none of which Companion models, all of which must survive an edit.
const providerObject = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Apple Inc.//macOS 15//EN\r\n" +
	"BEGIN:VEVENT\r\nUID:ABC-123\r\nDTSTAMP:20260901T100000Z\r\nSEQUENCE:2\r\n" +
	"DTSTART;TZID=America/Halifax:20260920T140000\r\nDTEND;TZID=America/Halifax:20260920T150000\r\n" +
	"SUMMARY:Dentist\r\nLOCATION:Spring Garden Rd\r\n" +
	"ATTENDEE;CN=Sam:mailto:sam@example.com\r\nX-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC\r\n" +
	"BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER:-PT30M\r\nEND:VALARM\r\n" +
	"END:VEVENT\r\nEND:VCALENDAR\r\n"

const weeklyObject = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\n" +
	"BEGIN:VEVENT\r\nUID:WEEKLY-1\r\nDTSTAMP:20260901T100000Z\r\n" +
	"DTSTART:20260907T090000Z\r\nDTEND:20260907T093000Z\r\nRRULE:FREQ=WEEKLY;COUNT=4\r\nSUMMARY:Standup\r\n" +
	"END:VEVENT\r\n" +
	"BEGIN:VEVENT\r\nUID:WEEKLY-1\r\nDTSTAMP:20260901T100000Z\r\nRECURRENCE-ID:20260914T090000Z\r\n" +
	"DTSTART:20260914T150000Z\r\nDTEND:20260914T153000Z\r\nSUMMARY:Standup (moved)\r\n" +
	"END:VEVENT\r\nEND:VCALENDAR\r\n"

func TestNewObjectRoundTrips(t *testing.T) {
	start := time.Date(2026, 9, 21, 15, 0, 0, 0, time.UTC)
	end := start.Add(45 * time.Minute)
	ics, err := NewObject("UID-1", EventFields{Title: "Lunch; with, Sam", StartsAt: start, EndsAt: &end, Location: ptr("Cafe")}, editNow)
	if err != nil {
		t.Fatal(err)
	}
	events, err := ExpandObject(ics, "feed", editNow)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("want 1 occurrence, got %d", len(events))
	}
	e := events[0]
	if e.Title != "Lunch; with, Sam" || !e.StartsAt.Equal(start) || e.EndsAt == nil || !e.EndsAt.Equal(end) || e.AllDay {
		t.Errorf("round trip mismatch: %+v", e)
	}
	if e.Location == nil || *e.Location != "Cafe" || e.ICSUID != "UID-1" {
		t.Errorf("location/uid mismatch: %+v", e)
	}
	info, err := InspectObject(ics)
	if err != nil || info.UID != "UID-1" || info.Recurring {
		t.Errorf("inspect: %+v %v", info, err)
	}
}

func TestNewObjectAllDay(t *testing.T) {
	day := time.Date(2026, 9, 25, 0, 0, 0, 0, time.UTC)
	ics, err := NewObject("UID-2", EventFields{Title: "Off", StartsAt: day, AllDay: true}, editNow)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ics, "DTSTART;VALUE=DATE:20260925") || !strings.Contains(ics, "DTEND;VALUE=DATE:20260926") {
		t.Fatalf("all-day not written as DATE with exclusive end:\n%s", ics)
	}
	events, _ := ExpandObject(ics, "feed", editNow)
	if len(events) != 1 || !events[0].AllDay || !events[0].StartsAt.Equal(day) {
		t.Fatalf("all-day round trip: %+v", events)
	}
}

func TestNewObjectRejectsBackwardsTimes(t *testing.T) {
	start := time.Date(2026, 9, 21, 15, 0, 0, 0, time.UTC)
	end := start.Add(-time.Minute)
	if _, err := NewObject("U", EventFields{Title: "x", StartsAt: start, EndsAt: &end}, editNow); err != ErrInvalidEventTimes {
		t.Fatalf("want ErrInvalidEventTimes, got %v", err)
	}
}

func TestApplyEditPreservesUnmodelledProperties(t *testing.T) {
	out, err := ApplyEdit(providerObject, EventPatch{Title: ptr("Dentist (rescheduled)"), Location: ptr("")}, editNow)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"SUMMARY:Dentist (rescheduled)",
		"ATTENDEE;CN=Sam:mailto:sam@example.com",
		"X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC",
		"BEGIN:VALARM", "TRIGGER:-PT30M",
		"DTSTART;TZID=America/Halifax:20260920T140000", // a rename must not rewrite the time zone
		"SEQUENCE:3",
		"PRODID:-//Apple Inc.//macOS 15//EN",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	if strings.Contains(out, "LOCATION") {
		t.Errorf("blank location should remove the property:\n%s", out)
	}
}

func TestApplyEditMovesEventKeepingDuration(t *testing.T) {
	newStart := time.Date(2026, 9, 22, 18, 0, 0, 0, time.UTC)
	out, err := ApplyEdit(providerObject, EventPatch{StartsAt: &newStart}, editNow)
	if err != nil {
		t.Fatal(err)
	}
	events, _ := ExpandObject(out, "feed", editNow)
	if len(events) != 1 || !events[0].StartsAt.Equal(newStart) || !events[0].EndsAt.Equal(newStart.Add(time.Hour)) {
		t.Fatalf("move: %+v", events)
	}
}

func TestApplyEditSameTimeIsNotAMove(t *testing.T) {
	same := time.Date(2026, 9, 20, 17, 0, 0, 0, time.UTC) // 14:00 Halifax (ADT, UTC-3)
	out, err := ApplyEdit(providerObject, EventPatch{StartsAt: &same, Title: ptr("x")}, editNow)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "DTSTART;TZID=America/Halifax:20260920T140000") {
		t.Errorf("unchanged instant must keep its TZID form:\n%s", out)
	}
}

func TestApplyEditRefusesToMoveRecurring(t *testing.T) {
	newStart := time.Date(2026, 9, 8, 9, 0, 0, 0, time.UTC)
	if _, err := ApplyEdit(weeklyObject, EventPatch{StartsAt: &newStart}, editNow); err != ErrRecurringTimeEdit {
		t.Fatalf("want ErrRecurringTimeEdit, got %v", err)
	}
	// Renaming the series is fine and leaves the override alone.
	out, err := ApplyEdit(weeklyObject, EventPatch{Title: ptr("Daily sync")}, editNow)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "SUMMARY:Daily sync") || !strings.Contains(out, "SUMMARY:Standup (moved)") {
		t.Errorf("series rename:\n%s", out)
	}
}

func TestExpandHonoursOverrides(t *testing.T) {
	events, err := ExpandObject(weeklyObject, "feed", editNow)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 4 {
		t.Fatalf("want 4 occurrences (3 regular + 1 moved), got %d", len(events))
	}
	moved := time.Date(2026, 9, 14, 15, 0, 0, 0, time.UTC)
	original := time.Date(2026, 9, 14, 9, 0, 0, 0, time.UTC)
	var sawMoved bool
	for _, e := range events {
		if e.StartsAt.Equal(original) {
			t.Errorf("the overridden instant must not also appear")
		}
		if e.StartsAt.Equal(moved) {
			sawMoved = e.Title == "Standup (moved)"
		}
	}
	if !sawMoved {
		t.Errorf("moved occurrence missing")
	}
}

func TestExcludeOccurrence(t *testing.T) {
	// A plain occurrence gets an EXDATE.
	plain := time.Date(2026, 9, 21, 9, 0, 0, 0, time.UTC)
	out, err := ExcludeOccurrence(weeklyObject, plain, editNow)
	if err != nil {
		t.Fatal(err)
	}
	events, _ := ExpandObject(out, "feed", editNow)
	if len(events) != 3 {
		t.Fatalf("want 3 after excluding one, got %d", len(events))
	}
	// Excluding the moved occurrence (addressed by where it now is) drops the override and
	// excludes the instant it replaced.
	moved := time.Date(2026, 9, 14, 15, 0, 0, 0, time.UTC)
	out, err = ExcludeOccurrence(weeklyObject, moved, editNow)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "RECURRENCE-ID") {
		t.Errorf("override should be gone:\n%s", out)
	}
	if !strings.Contains(out, "EXDATE:20260914T090000Z") {
		t.Errorf("want EXDATE for the replaced instant:\n%s", out)
	}
	events, _ = ExpandObject(out, "feed", editNow)
	if len(events) != 3 {
		t.Fatalf("want 3 after excluding the moved one, got %d", len(events))
	}
	if _, err := ExcludeOccurrence(providerObject, plain, editNow); err == nil {
		t.Errorf("excluding from a non-repeating event should fail")
	}
}

func TestSameContent(t *testing.T) {
	a, _ := ApplyEdit(providerObject, EventPatch{Title: ptr("New")}, editNow)
	b, _ := ApplyEdit(providerObject, EventPatch{Title: ptr("New")}, editNow.Add(time.Hour)) // other device, later stamp
	if !SameContent(a, b) {
		t.Errorf("same edit from two devices should compare equal")
	}
	if SameContent(a, providerObject) {
		t.Errorf("a rename is a content change")
	}
}

func TestObjectIDIsStableAndScoped(t *testing.T) {
	if ObjectID("f", "u") != ObjectID("f", "u") || ObjectID("f", "u") == ObjectID("g", "u") {
		t.Errorf("object id must be deterministic per feed")
	}
	if ObjectID("f", "u") == EventID("f", "u", time.Time{}) {
		t.Errorf("object and event ids must not collide")
	}
}

// A weekly meeting as Apple Calendar writes it: zoned start, BYDAY restating the start's weekday,
// one deleted occurrence. It begins before Halifax leaves daylight time (Nov 1, 2026) and the
// occurrence edited below falls after — the case where adding a raw duration drifts by an hour.
const zonedWeekly = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Apple Inc.//macOS 15//EN\r\n" +
	"BEGIN:VEVENT\r\nUID:ZW-1\r\nDTSTAMP:20260901T100000Z\r\n" +
	"DTSTART;TZID=America/Halifax:20261019T090000\r\nDTEND;TZID=America/Halifax:20261019T100000\r\n" +
	"RRULE:FREQ=WEEKLY;BYDAY=MO\r\nEXDATE;TZID=America/Halifax:20261026T090000\r\n" +
	"SUMMARY:Team sync\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"

func halifax(t *testing.T, y int, m time.Month, d, h, min int) time.Time {
	t.Helper()
	loc, err := time.LoadLocation("America/Halifax")
	if err != nil {
		t.Skip("no tzdata")
	}
	return time.Date(y, m, d, h, min, 0, 0, loc)
}

func TestMovingOneOccurrenceMovesTheSeriesOnTheWallClock(t *testing.T) {
	now := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
	occ := halifax(t, 2026, 11, 9, 9, 0)       // a Monday, after the DST change
	newOcc := halifax(t, 2026, 11, 10, 10, 30) // → Tuesdays at 10:30
	newEnd := newOcc.Add(45 * time.Minute)
	out, err := ApplyEdit(zonedWeekly, EventPatch{StartsAt: &newOcc, EndsAt: &newEnd, OccurrenceStart: &occ}, now)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"DTSTART;TZID=America/Halifax:20261020T103000", // first occurrence: +1 day, 10:30 LOCAL — no DST drift, zone kept
		"DTEND;TZID=America/Halifax:20261020T111500",
		"EXDATE;TZID=America/Halifax:20261027T103000", // the deleted occurrence stays deleted
		"RRULE:FREQ=WEEKLY",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	if strings.Contains(out, "BYDAY") {
		t.Errorf("BYDAY=MO must not survive a move to Tuesday:\n%s", out)
	}
	events, _ := ExpandObject(out, "f", now)
	var sawEdited, sawExcluded bool
	for _, e := range events {
		if e.StartsAt.Equal(newOcc) {
			sawEdited = e.EndsAt != nil && e.EndsAt.Equal(newEnd)
		}
		if e.StartsAt.Equal(halifax(t, 2026, 10, 27, 10, 30)) {
			sawExcluded = true
		}
	}
	if !sawEdited {
		t.Errorf("the edited occurrence should land exactly where the user put it")
	}
	if sawExcluded {
		t.Errorf("the excluded occurrence came back")
	}
}

func TestCustomRepeatAllowsATimeChangeButNotADayChange(t *testing.T) {
	custom := strings.Replace(zonedWeekly, "RRULE:FREQ=WEEKLY;BYDAY=MO", "RRULE:FREQ=MONTHLY;BYDAY=3MO", 1)
	now := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
	occ := halifax(t, 2026, 10, 19, 9, 0)
	later := halifax(t, 2026, 10, 19, 14, 0)
	out, err := ApplyEdit(custom, EventPatch{StartsAt: &later, OccurrenceStart: &occ}, now)
	if err != nil || !strings.Contains(out, "RRULE:FREQ=MONTHLY;BYDAY=3MO") || !strings.Contains(out, "20261019T140000") {
		t.Fatalf("a time-of-day change must keep a custom rule intact: %v\n%s", err, out)
	}
	nextDay := halifax(t, 2026, 10, 20, 9, 0)
	if _, err := ApplyEdit(custom, EventPatch{StartsAt: &nextDay, OccurrenceStart: &occ}, now); err != ErrRecurringTimeEdit {
		t.Fatalf("want ErrRecurringTimeEdit, got %v", err)
	}
	// …unless the user replaces the rule in the same edit.
	if _, err := ApplyEdit(custom, EventPatch{StartsAt: &nextDay, OccurrenceStart: &occ, Repeat: &Repeat{Freq: RepeatWeekly}}, now); err != nil {
		t.Fatalf("replacing the rule should allow the move: %v", err)
	}
}

func TestSetReadAndClearRepeat(t *testing.T) {
	start := time.Date(2026, 9, 21, 15, 0, 0, 0, time.UTC)
	end := start.Add(time.Hour)
	until := time.Date(2026, 10, 19, 0, 0, 0, 0, time.UTC)
	ics, err := NewObject("R-1", EventFields{Title: "Gym", StartsAt: start, EndsAt: &end,
		Repeat: &Repeat{Freq: RepeatWeekly, Interval: 2, Until: &until}}, editNow)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ics, "RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20261019T235959Z") {
		t.Fatalf("rule not written as expected:\n%s", ics)
	}
	info, _ := InspectObject(ics)
	if !info.Recurring || info.Repeat == nil || info.Repeat.Freq != RepeatWeekly || info.Repeat.Interval != 2 ||
		info.Repeat.Custom || info.Repeat.Until == nil || !info.Repeat.Until.Equal(until) {
		t.Fatalf("rule not read back: %+v", info.Repeat)
	}
	if events, _ := ExpandObject(ics, "f", editNow); len(events) != 3 { // Sep 21, Oct 5, Oct 19
		t.Fatalf("want 3 fortnightly occurrences up to and including the until day, got %d", len(events))
	}

	// Change the rule.
	daily, err := ApplyEdit(ics, EventPatch{Repeat: &Repeat{Freq: RepeatDaily}}, editNow)
	if err != nil || !strings.Contains(daily, "RRULE:FREQ=DAILY\r\n") {
		t.Fatalf("change rule: %v\n%s", err, daily)
	}

	// Remove it while looking at the Oct 5 occurrence: THAT one is what remains.
	viewed := time.Date(2026, 10, 5, 15, 0, 0, 0, time.UTC)
	single, err := ApplyEdit(ics, EventPatch{Repeat: &Repeat{Freq: RepeatNone}, OccurrenceStart: &viewed}, editNow)
	if err != nil {
		t.Fatal(err)
	}
	events, _ := ExpandObject(single, "f", editNow)
	if strings.Contains(single, "RRULE") || len(events) != 1 || !events[0].StartsAt.Equal(viewed) {
		t.Fatalf("clearing the repeat should leave the viewed occurrence: %+v\n%s", events, single)
	}

	// Removing the repeat from a series with an override drops the override too.
	flat, err := ApplyEdit(weeklyObject, EventPatch{Repeat: &Repeat{Freq: RepeatNone}}, editNow)
	if err != nil || strings.Contains(flat, "RECURRENCE-ID") {
		t.Fatalf("override should go with the series: %v\n%s", err, flat)
	}
}

func TestRepeatValidationAndAllDayUntil(t *testing.T) {
	day := time.Date(2026, 9, 25, 0, 0, 0, 0, time.UTC)
	before := day.AddDate(0, 0, -1)
	if _, err := NewObject("U", EventFields{Title: "x", StartsAt: day, AllDay: true, Repeat: &Repeat{Freq: RepeatDaily, Until: &before}}, editNow); err == nil {
		t.Error("a repeat ending before the event starts should be refused")
	}
	if _, err := NewObject("U", EventFields{Title: "x", StartsAt: day, Repeat: &Repeat{Freq: "fortnightly"}}, editNow); err == nil {
		t.Error("an unknown frequency should be refused")
	}
	until := day.AddDate(0, 0, 2)
	ics, err := NewObject("U", EventFields{Title: "Trip", StartsAt: day, AllDay: true, Repeat: &Repeat{Freq: RepeatDaily, Until: &until}}, editNow)
	if err != nil || !strings.Contains(ics, "UNTIL=20260927\r\n") {
		t.Fatalf("an all-day rule's UNTIL must be a DATE: %v\n%s", err, ics)
	}
	if _, err := ApplyEdit(ics, EventPatch{AllDay: ptr(false)}, editNow); err != ErrRecurringAllDayToggle {
		t.Errorf("want ErrRecurringAllDayToggle, got %v", err)
	}
}

func TestReadRepeatTellsSimpleFromCustom(t *testing.T) {
	base := func(rule string) string {
		return strings.Replace(zonedWeekly, "RRULE:FREQ=WEEKLY;BYDAY=MO", "RRULE:"+rule, 1) // starts Mon 19 Oct 2026
	}
	for rule, custom := range map[string]bool{
		"FREQ=WEEKLY;BYDAY=MO":                 false, // restates the start's weekday
		"FREQ=WEEKLY;INTERVAL=2":               false,
		"FREQ=MONTHLY;BYMONTHDAY=19":           false,
		"FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=19": false,
		"FREQ=WEEKLY;BYDAY=MO,WE":              true,
		"FREQ=WEEKLY;BYDAY=TU":                 true, // not the start's weekday
		"FREQ=MONTHLY;BYDAY=3MO":               true,
		"FREQ=DAILY;COUNT=5":                   true,
	} {
		info, err := InspectObject(base(rule))
		if err != nil || info.Repeat == nil {
			t.Fatalf("%s: %v %+v", rule, err, info)
		}
		if info.Repeat.Custom != custom {
			t.Errorf("%s: custom = %v, want %v", rule, info.Repeat.Custom, custom)
		}
	}
}
