package domain

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Repeating projects (PLAN-scheduling.md §3). Unlike a repeating task — a hidden seed whose
// occurrences the server stamps out — a repeating project is a chain of ordinary projects: the
// newest copy carries the repeat definition, and when its next turn comes the server copies it
// (the project, and its tasks reset to open) and moves the definition onto the copy. This file
// holds the pieces both sides agree on: the after-completion interval, where the next copy
// lands, and the deterministic ids that make spawning idempotent.

// ErrInvalidRepeatAfter wraps a malformed after-completion interval.
var ErrInvalidRepeatAfter = errors.New("invalid repeat interval")

// RepeatAfterUnit is the unit of an after-completion interval.
type RepeatAfterUnit byte

const (
	RepeatAfterDays   RepeatAfterUnit = 'D'
	RepeatAfterWeeks  RepeatAfterUnit = 'W'
	RepeatAfterMonths RepeatAfterUnit = 'M'
	RepeatAfterYears  RepeatAfterUnit = 'Y'
)

// RepeatAfter is "N units after completion": a single-unit ISO-8601 date duration ("P3D",
// "P2W", "P1M", "P1Y").
type RepeatAfter struct {
	N    int
	Unit RepeatAfterUnit
}

// maxRepeatAfterN bounds the count so a typo can't park a project a millennium out.
const maxRepeatAfterN = 1000

var repeatAfterRe = regexp.MustCompile(`^P(\d+)([DWMY])$`)

// ParseRepeatAfter parses an after-completion interval. Zero is rejected: a project that came
// straight back the moment it was completed could never be finished.
func ParseRepeatAfter(s string) (RepeatAfter, error) {
	m := repeatAfterRe.FindStringSubmatch(strings.ToUpper(strings.TrimSpace(s)))
	if m == nil {
		return RepeatAfter{}, errors.Join(ErrInvalidRepeatAfter, fmt.Errorf("%q must be a whole number of days, weeks, months or years such as P3D, P2W, P1M or P1Y", s))
	}
	n, err := strconv.Atoi(m[1])
	if err != nil || n < 1 || n > maxRepeatAfterN {
		return RepeatAfter{}, errors.Join(ErrInvalidRepeatAfter, fmt.Errorf("%q must be between 1 and %d units", s, maxRepeatAfterN))
	}
	return RepeatAfter{N: n, Unit: RepeatAfterUnit(m[2][0])}, nil
}

// String renders the interval in its canonical form.
func (r RepeatAfter) String() string {
	return "P" + strconv.Itoa(r.N) + string(rune(r.Unit))
}

// After returns the instant the interval lands on, counted forward from t: calendar arithmetic
// in UTC, the same on every device and the server. A month or year step is clamped to the
// target month's length, so a month after Jan 31 is Feb 28 (29 in a leap year), never Mar 3.
func (r RepeatAfter) After(t time.Time) time.Time {
	t = t.UTC()
	switch r.Unit {
	case RepeatAfterWeeks:
		return t.AddDate(0, 0, 7*r.N)
	case RepeatAfterMonths:
		return monthsAfter(t, r.N)
	case RepeatAfterYears:
		return monthsAfter(t, 12*r.N)
	default:
		return t.AddDate(0, 0, r.N)
	}
}

// monthsAfter adds n calendar months to t, clamping the day to the target month's length.
func monthsAfter(t time.Time, n int) time.Time {
	first := time.Date(t.Year(), t.Month(), 1, t.Hour(), t.Minute(), t.Second(), t.Nanosecond(), time.UTC).AddDate(0, n, 0)
	lastDay := first.AddDate(0, 1, -1).Day()
	day := t.Day()
	if day > lastDay {
		day = lastDay
	}
	return first.AddDate(0, 0, day-1)
}

// NextAfterCompletion places the next copy of an after-completion project: `after` past the
// moment it was completed. When the finished copy had a schedule (anchor: its start, else its
// deadline) the next one keeps that clock time — the latest instant at the anchor's
// time-of-day not past the raw landing point — so a project that starts at 9:00 keeps starting
// at 9:00 whatever hour it was ticked off.
func NextAfterCompletion(after RepeatAfter, completedAt time.Time, anchor *time.Time) time.Time {
	landing := after.After(completedAt)
	if anchor == nil {
		return landing
	}
	a := anchor.UTC()
	at := time.Date(landing.Year(), landing.Month(), landing.Day(), a.Hour(), a.Minute(), a.Second(), 0, time.UTC)
	if at.After(landing) {
		at = at.AddDate(0, 0, -1)
	}
	return at
}

// NextScheduled places the next copy of a scheduled (RRULE) project whose current copy sits at
// `anchor`: the latest occurrence at or before `now` that is still after the anchor — so a
// server that was down for a week makes one fresh copy, not seven — or, when `eager`, simply the
// first occurrence after the anchor. nil means nothing is due (or the rule has ended).
//
// eager is for a deadline-only project: its copy is only useful *before* its deadline, so the
// next one is made as soon as the current deadline has passed rather than at its own instant.
func NextScheduled(rule string, anchor, now time.Time, eager bool) (*time.Time, error) {
	if eager {
		if now.Before(anchor) {
			return nil, nil
		}
		return NextOccurrence(rule, anchor, anchor)
	}
	latest, err := LatestOccurrence(rule, anchor, now)
	if err != nil || latest == nil || !latest.After(anchor.UTC().Truncate(time.Second)) {
		return nil, err
	}
	return latest, nil
}

// repeatNamespace scopes the deterministic ids below (an arbitrary fixed UUID).
var repeatNamespace = uuid.MustParse("6f0d3c1e-8a54-4b7e-9d3a-5c2b7e1f4a90")

// NextProjectID is the id of the copy spawned from project `prevID` for the turn at `at`.
// Deterministic, so a retried or concurrent spawn lands on the same row instead of making a
// second copy; keyed by the instant too, so a copy the user hands the repeat back to can spawn
// again.
func NextProjectID(prevID string, at time.Time) string {
	return uuid.NewSHA1(repeatNamespace, []byte("project:"+prevID+":"+at.UTC().Format(time.RFC3339))).String()
}

// CopiedTaskID is the id of task `taskID`'s copy inside the spawned project `nextProjectID`.
func CopiedTaskID(nextProjectID, taskID string) string {
	return uuid.NewSHA1(repeatNamespace, []byte("task:"+nextProjectID+":"+taskID)).String()
}

// CopiedListID is the id of list `listID`'s copy inside the spawned project `nextProjectID`.
func CopiedListID(nextProjectID, listID string) string {
	return uuid.NewSHA1(repeatNamespace, []byte("list:"+nextProjectID+":"+listID)).String()
}

// CopiedHeadingID is the id of heading `itemID`'s copy inside the copied list `nextListID`.
// (A copied task item takes the ordinary ListTaskItemID of its new list and task.)
func CopiedHeadingID(nextListID, itemID string) string {
	return uuid.NewSHA1(repeatNamespace, []byte("heading:"+nextListID+":"+itemID)).String()
}
