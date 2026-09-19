package domain

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Reminders (PLAN §6.4). A task carries any number of reminders, each either an absolute
// instant ("tomorrow at 9am") or a lead counted back from the task's deadline ("the day
// before", "a month before"). A lead is what lets a relative reminder survive a deadline
// change or a repeat: its fire time is derived from whatever the deadline currently is and is
// never stored. The same functions resolve fire times on every device (notification plans) and
// on the server (timing repeat occurrences), so they agree on every instant.

// MaxReminders caps how many reminders one task carries, bounding every notification plan
// (iOS gives an app 64 pending notifications in total).
const MaxReminders = 10

// maxLeadN bounds a lead's count, so a typo ("100000 days before") is rejected rather than
// resolving to an instant centuries back.
const maxLeadN = 1000

// Reminder is one notification a task carries. Exactly one of At / Before is set.
type Reminder struct {
	// At is an absolute instant.
	At *time.Time `json:"at,omitempty"`
	// Before counts back from the task's deadline (DueAt): an ISO-8601 duration of a single
	// unit — "PT0M" (at the deadline), "PT30M", "PT1H", "P1D", "P3D", "P1W", "P2W", "P1M". On a
	// task with no deadline it is kept but never fires; it resumes once a deadline is set.
	Before string `json:"before,omitempty"`
}

// ErrInvalidReminder is returned when a reminder fails validation.
var ErrInvalidReminder = errors.New("invalid reminder")

// LeadUnit is the single unit a relative reminder's lead is counted in.
type LeadUnit byte

const (
	LeadMinutes LeadUnit = 'm'
	LeadHours   LeadUnit = 'h'
	LeadDays    LeadUnit = 'D'
	LeadWeeks   LeadUnit = 'W'
	LeadMonths  LeadUnit = 'M'
)

// Lead is a parsed relative-reminder offset: N units before the deadline. The zero Lead means
// "at the deadline".
type Lead struct {
	N    int
	Unit LeadUnit
}

// leadRe matches the single-unit ISO-8601 durations a lead may take, after upper-casing. The
// date part's M is months; the time part's M is minutes.
var leadRe = regexp.MustCompile(`^P(?:(\d+)([DWM])|T(\d+)([HM]))$`)

// ParseLead parses a lead ("P1D", "pt30m", "P2W", "P1M"). Every zero lead ("P0D", "PT0M")
// normalizes to the same "at the deadline" lead.
func ParseLead(s string) (Lead, error) {
	m := leadRe.FindStringSubmatch(strings.ToUpper(strings.TrimSpace(s)))
	if m == nil {
		return Lead{}, fmt.Errorf("lead %q must be a single-unit ISO-8601 duration such as PT1H, P1D, P1W or P1M", s)
	}
	var (
		digits string
		unit   LeadUnit
	)
	if m[1] != "" {
		digits, unit = m[1], LeadUnit(m[2][0])
	} else {
		digits, unit = m[3], LeadHours
		if m[4] == "M" {
			unit = LeadMinutes
		}
	}
	n, err := strconv.Atoi(digits)
	if err != nil || n > maxLeadN {
		return Lead{}, fmt.Errorf("lead %q is out of range (at most %d units)", s, maxLeadN)
	}
	if n == 0 {
		return Lead{Unit: LeadMinutes}, nil
	}
	return Lead{N: n, Unit: unit}, nil
}

// String renders the lead in its canonical ISO-8601 form.
func (l Lead) String() string {
	n := strconv.Itoa(l.N)
	switch l.Unit {
	case LeadHours:
		return "PT" + n + "H"
	case LeadDays:
		return "P" + n + "D"
	case LeadWeeks:
		return "P" + n + "W"
	case LeadMonths:
		return "P" + n + "M"
	default:
		return "PT" + n + "M"
	}
}

// Before returns the instant the lead lands on, counted back from t. Days, weeks and months are
// calendar arithmetic in UTC — the same on every device and the server — and a month back is
// clamped to the target month's length: a month before Mar 31 is Feb 28 (29 in a leap year),
// never Mar 3. Across a daylight-saving change a day-or-longer lead can therefore land an hour
// off the deadline's local clock time.
func (l Lead) Before(t time.Time) time.Time {
	t = t.UTC()
	switch l.Unit {
	case LeadHours:
		return t.Add(-time.Duration(l.N) * time.Hour)
	case LeadDays:
		return t.AddDate(0, 0, -l.N)
	case LeadWeeks:
		return t.AddDate(0, 0, -7*l.N)
	case LeadMonths:
		return monthsBefore(t, l.N)
	default:
		return t.Add(-time.Duration(l.N) * time.Minute)
	}
}

// Approx is the lead as a fixed duration, counting a month as 31 days: an upper bound, used to
// order leads and to decide how early a repeat occurrence must exist for its reminders to fire.
func (l Lead) Approx() time.Duration {
	day := 24 * time.Hour
	switch l.Unit {
	case LeadHours:
		return time.Duration(l.N) * time.Hour
	case LeadDays:
		return time.Duration(l.N) * day
	case LeadWeeks:
		return time.Duration(l.N) * 7 * day
	case LeadMonths:
		return time.Duration(l.N) * 31 * day
	default:
		return time.Duration(l.N) * time.Minute
	}
}

// monthsBefore steps t back n calendar months, clamping the day of month to the target
// month's length.
func monthsBefore(t time.Time, n int) time.Time {
	y, m, d := t.Date()
	first := time.Date(y, m-time.Month(n), 1, t.Hour(), t.Minute(), t.Second(), t.Nanosecond(), time.UTC)
	if last := first.AddDate(0, 1, -1).Day(); d > last {
		d = last
	}
	return first.AddDate(0, 0, d-1)
}

// Validate checks that exactly one of At / Before is set and that a lead parses.
func (r Reminder) Validate() error {
	hasAt, hasBefore := r.At != nil, strings.TrimSpace(r.Before) != ""
	if hasAt == hasBefore {
		return errors.Join(ErrInvalidReminder, errors.New("a reminder sets exactly one of at or before"))
	}
	if hasBefore {
		if _, err := ParseLead(r.Before); err != nil {
			return errors.Join(ErrInvalidReminder, err)
		}
	}
	return nil
}

// FireAt resolves the reminder against a deadline: an absolute reminder fires at its instant;
// a relative one at the deadline minus its lead, or never (nil) when there is no deadline.
func (r Reminder) FireAt(deadline *time.Time) *time.Time {
	if r.At != nil {
		at := r.At.UTC()
		return &at
	}
	if deadline == nil {
		return nil
	}
	l, err := ParseLead(r.Before)
	if err != nil {
		return nil
	}
	at := l.Before(*deadline)
	return &at
}

// ValidateReminders checks a task's reminder list: at most MaxReminders, each valid.
func ValidateReminders(rs []Reminder) error {
	if len(rs) > MaxReminders {
		return errors.Join(ErrInvalidReminder, fmt.Errorf("a task can have at most %d reminders", MaxReminders))
	}
	for _, r := range rs {
		if err := r.Validate(); err != nil {
			return err
		}
	}
	return nil
}

// NormalizeReminders validates each reminder, canonicalizes it (instants in UTC, leads in
// their ISO form with every zero lead as "PT0M"), drops duplicates, and orders the list —
// relative leads longest-first (the order they fire in), then instants chronologically — so
// equal lists always store and sync identically. It never returns nil, so the list always
// serializes as a JSON array.
func NormalizeReminders(in []Reminder) ([]Reminder, error) {
	out := make([]Reminder, 0, len(in))
	seen := map[string]bool{}
	for _, r := range in {
		if err := r.Validate(); err != nil {
			return nil, err
		}
		var key string
		if r.At != nil {
			at := r.At.UTC()
			r = Reminder{At: &at}
			key = "at:" + at.Format(time.RFC3339Nano)
		} else {
			l, _ := ParseLead(r.Before) // validated above
			r = Reminder{Before: l.String()}
			key = "before:" + r.Before
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, r)
	}
	if err := ValidateReminders(out); err != nil {
		return nil, err
	}
	sort.SliceStable(out, func(i, j int) bool { return reminderLess(out[i], out[j]) })
	return out, nil
}

// reminderLess orders relative reminders before absolute ones: leads longest-first,
// instants chronologically.
func reminderLess(a, b Reminder) bool {
	if (a.At == nil) != (b.At == nil) {
		return a.At == nil
	}
	if a.At != nil {
		return a.At.Before(*b.At)
	}
	la, _ := ParseLead(a.Before)
	lb, _ := ParseLead(b.Before)
	if la.Approx() != lb.Approx() {
		return la.Approx() > lb.Approx()
	}
	return a.Before < b.Before
}

// ShiftReminders moves reminders along with a repeating task's dates: an absolute instant
// shifts by delta, keeping its distance from the moved dates, while a relative lead already
// follows the deadline and is copied as-is.
func ShiftReminders(rs []Reminder, delta time.Duration) []Reminder {
	out := make([]Reminder, 0, len(rs))
	for _, r := range rs {
		if r.At != nil {
			at := r.At.Add(delta).UTC()
			r = Reminder{At: &at}
		}
		out = append(out, r)
	}
	return out
}

// Reminder phrases: relative reminders typed the way people say them. Parsed in Go, like
// repeat phrases (ParseRepeatPhrase), so every platform reads "a few days before" the same way.
// "A few" is three of a unit, except weeks, where it is two — three weeks is nearly the month
// preset, and two keeps the presets evenly spread (day · 3 days · week · 2 weeks · month).
var (
	reminderSpaceRe      = regexp.MustCompile(`\s+`)
	reminderAtDeadlineRe = regexp.MustCompile(`^(?:(?:at|on|by) (?:the )?(?:deadline|due date|due time)|when (?:it'?s |it is )?due|on time)$`)
	reminderLeadRe       = regexp.MustCompile(`^(?:(\d+) ?|(.+?) )?(minutes?|mins?|hours?|hrs?|days?|weeks?|wks?|months?|mos?|m|h|d|w|mo) (?:before|prior|earlier|early|ahead|in advance)(?: (?:the )?(?:deadline|due date|due time|it'?s due|it is due))?$`)
)

// reminderCountWords are the spelled-out counts a phrase may use.
var reminderCountWords = map[string]int{
	"a": 1, "an": 1, "one": 1, "the": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
	"seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
	"a couple of": 2, "a couple": 2, "couple of": 2, "couple": 2,
}

// ParseReminderPhrase reads a typed relative reminder — "the day before", "a few days before",
// "2 weeks before the deadline", "an hour before", "30m before", "at the deadline" — into a
// lead-based Reminder. ok is false for anything else: an absolute time ("tomorrow at 9am") is
// the caller's to resolve with the date parser.
func ParseReminderPhrase(text string) (r Reminder, ok bool) {
	s := strings.ToLower(strings.TrimSpace(text))
	s = strings.TrimRight(s, ".!")
	s = reminderSpaceRe.ReplaceAllString(s, " ")
	s = strings.TrimPrefix(s, "remind me ")
	if reminderAtDeadlineRe.MatchString(s) {
		return Reminder{Before: Lead{Unit: LeadMinutes}.String()}, true
	}
	m := reminderLeadRe.FindStringSubmatch(s)
	if m == nil {
		return Reminder{}, false
	}
	unit := reminderUnit(m[3])
	n := 1
	switch count := strings.TrimSpace(m[2]); {
	case m[1] != "":
		v, err := strconv.Atoi(m[1])
		if err != nil {
			return Reminder{}, false
		}
		n = v
	case count == "":
		// "day before": a bare unit is one of it.
	case count == "a few" || count == "few" || count == "several":
		n = 3
		if unit == LeadWeeks {
			n = 2
		}
	case count == "half an" || count == "half a":
		if unit != LeadHours {
			return Reminder{}, false
		}
		n, unit = 30, LeadMinutes
	default:
		v, known := reminderCountWords[count]
		if !known {
			return Reminder{}, false
		}
		n = v
	}
	if n > maxLeadN {
		return Reminder{}, false
	}
	return Reminder{Before: Lead{N: n, Unit: unit}.String()}, true
}

// reminderUnit maps a unit word (or abbreviation) to its LeadUnit. Bare "m" is minutes and
// "mo" months, the way people abbreviate them.
func reminderUnit(word string) LeadUnit {
	switch {
	case strings.HasPrefix(word, "mo"):
		return LeadMonths
	case strings.HasPrefix(word, "m"):
		return LeadMinutes
	case strings.HasPrefix(word, "h"):
		return LeadHours
	case strings.HasPrefix(word, "d"):
		return LeadDays
	default:
		return LeadWeeks
	}
}
