package things

import (
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/teambition/rrule-go"

	"companion/core/domain"
)

// A repeating project in Things is a hidden template (a project row with a rule, holding the
// to-dos each copy starts with) plus the copies it has made, which point back at it. Companion
// has no template: a repeating project is a chain of ordinary projects whose newest copy
// carries the repeat, and the server copies it when its next turn comes (PLAN-scheduling.md
// §2). So the repeat goes on the newest open copy Things made — or, when there is none (the
// last one was finished, or the first isn't due yet), the template itself is imported as the
// upcoming copy, starting on its next date.

// projectRepeat is a template's rule as a project's repeat definition: an RRULE, or an
// after-completion interval.
type projectRepeat struct {
	rule, after *string
	// endless is set when Things ends the repeat (after a number of times, or on a date) but
	// Companion can't: an after-completion repeat has no end.
	endless bool
}

// projectRepeatFor places a template's rule on a project whose schedule hangs off `anchor`.
//
// The server reads a project's RRULE from that anchor, in UTC, so the rule has to name the days
// the anchor falls on — not the dates Things' rule names. onStart says the anchor is the
// project's start, which Things puts `ts` days before each date; and an anchor at local midnight
// east of UTC (or a 5pm deadline far west of it) is on another UTC day. Both move the rule by
// whole days. `made` says the anchored project is a copy Things already made (and counted),
// rather than the template standing in for the next one.
//
// ok is false, with the reason, when the rule can't be moved. A nil rule and after with ok means
// the anchored project is the series' last copy.
func projectRepeatFor(r repeat, anchor time.Time, onStart, made bool, loc *time.Location) (pr projectRepeat, reason string, ok bool) {
	if r.afterCompletion {
		if r.interval < 1 || r.interval > 1000 {
			return pr, "its repeat interval is out of range", false
		}
		after := domain.RepeatAfter{N: int(r.interval), Unit: r.unit}.String()
		return projectRepeat{after: &after, endless: r.remaining > 0 || r.until != nil}, "", true
	}

	days := utcDayDelta(anchor, loc)
	if onStart {
		days += r.startOffset
	}
	parts, ok := shiftRule(r.parts, days)
	if !ok {
		if onStart && r.startOffset != 0 {
			return pr, "it starts " + strconv.Itoa(-r.startOffset) + " " + plural(-r.startOffset, "day", "days") + " before each date, a schedule Companion can’t repeat", false
		}
		return pr, "its schedule can’t be repeated in this time zone", false
	}

	// A project's rule is read afresh from each copy, so it can't count down: "ends after N"
	// becomes the day of the last copy.
	until := r.until
	if until != nil && onStart {
		moved := until.AddDate(0, 0, r.startOffset)
		until = &moved
	}
	if r.remaining > 0 {
		left := r.remaining
		if !made {
			left-- // the template's project is the next one itself
		}
		if left <= 0 {
			return projectRepeat{}, "", true
		}
		last, err := nthAfter(strings.Join(parts, ";"), anchor, left)
		if err != nil || last == nil {
			return pr, "its repeat rule couldn’t be converted", false
		}
		y, m, d := last.In(loc).Date()
		end := time.Date(y, m, d, 23, 59, 59, 0, loc).UTC()
		until = &end
	}
	if until != nil {
		parts = append(parts, "UNTIL="+until.UTC().Format(untilFormat))
	}
	rule := strings.Join(parts, ";")
	if err := domain.ValidateRepeatRule(&rule); err != nil {
		return pr, "its repeat rule couldn’t be converted", false
	}
	return projectRepeat{rule: &rule}, "", true
}

// utcDayDelta is how many days the UTC calendar date of t is from its date in loc: −1 for a
// local midnight east of UTC, +1 for an evening far enough west.
func utcDayDelta(t time.Time, loc *time.Location) int {
	ly, lm, ld := t.In(loc).Date()
	uy, um, ud := t.UTC().Date()
	local := time.Date(ly, lm, ld, 0, 0, 0, 0, time.UTC)
	utc := time.Date(uy, um, ud, 0, 0, 0, 0, time.UTC)
	return int(utc.Sub(local).Hours() / 24)
}

// nthAfter is the n-th occurrence of rule (read from anchor, as the server does) after anchor.
func nthAfter(rule string, anchor time.Time, n int64) (*time.Time, error) {
	opt, err := rrule.StrToROption(rule)
	if err != nil {
		return nil, err
	}
	opt.Dtstart = anchor.UTC().Truncate(time.Second)
	rr, err := rrule.NewRRule(*opt)
	if err != nil {
		return nil, err
	}
	next := rr.Iterator()
	var last *time.Time
	for tries := 0; n > 0 && tries < 100000; tries++ {
		t, ok := next()
		if !ok {
			break
		}
		if !t.After(opt.Dtstart) {
			continue
		}
		at := t.UTC()
		last = &at
		n--
	}
	if n > 0 {
		return nil, nil
	}
	return last, nil
}

var weekOrder = [7]string{"MO", "TU", "WE", "TH", "FR", "SA", "SU"}

// shiftRule moves every occurrence of a rule (its parts, as convertRule makes them) by a number
// of days. ok is false when the moved schedule isn't one an RRULE can say: an n-th weekday
// ("the first Monday" less three days isn't the first Friday), a yearly date pushed into
// another month, or days of an every-other-week or every-other-month rule pushed into different
// weeks or months.
func shiftRule(parts []string, days int) ([]string, bool) {
	if days == 0 {
		return parts, true
	}
	freq, interval := "", 1
	for _, p := range parts {
		switch k, v, _ := strings.Cut(p, "="); k {
		case "FREQ":
			freq = v
		case "INTERVAL":
			interval, _ = strconv.Atoi(v)
		}
	}
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		k, v, _ := strings.Cut(p, "=")
		switch k {
		case "BYDAY":
			if freq != "WEEKLY" {
				return nil, false
			}
			var moved []string
			weeks := map[int]bool{}
			for _, code := range strings.Split(v, ",") {
				i := weekdayOrder(code)
				if i > 6 || len(code) != 2 {
					return nil, false
				}
				n := i + days
				weeks[floorDiv(n, 7)] = true
				moved = appendUnique(moved, weekOrder[n-7*floorDiv(n, 7)])
			}
			if interval > 1 && len(weeks) > 1 {
				return nil, false
			}
			sort.SliceStable(moved, func(i, j int) bool { return weekdayOrder(moved[i]) < weekdayOrder(moved[j]) })
			out = append(out, "BYDAY="+strings.Join(moved, ","))
		case "BYMONTHDAY":
			var moved []string
			months := map[int]bool{}
			for _, s := range strings.Split(v, ",") {
				d, err := strconv.Atoi(s)
				if err != nil || d == 0 {
					return nil, false
				}
				// Counted from the front, a day stays in its month while it is one every month
				// has; before the 1st it becomes a day counted from the end of the month before
				// (the 1st less three days is the third-last day: −3). And the mirror image for
				// a day counted from the end.
				n, month := d+days, 0
				switch {
				case d > 0 && n >= 1 && (days < 0 || n <= 28):
				case d > 0 && n <= 0 && n > -28:
					n, month = n-1, -1
				case d < 0 && n <= -1 && (days > 0 || n >= -28):
				case d < 0 && n >= 0 && n < 28:
					n, month = n+1, 1
				default:
					return nil, false
				}
				months[month] = true
				moved = appendUnique(moved, strconv.Itoa(n))
			}
			crossed := months[-1] || months[1]
			if crossed && (freq == "YEARLY" || interval > 1 && len(months) > 1) {
				return nil, false
			}
			out = append(out, "BYMONTHDAY="+strings.Join(moved, ","))
		default:
			out = append(out, p)
		}
	}
	return out, true
}

func floorDiv(a, b int) int {
	q := a / b
	if a%b != 0 && (a < 0) != (b < 0) {
		q--
	}
	return q
}
