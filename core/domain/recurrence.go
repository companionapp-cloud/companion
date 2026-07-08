package domain

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"companion/core/dates"

	"github.com/teambition/rrule-go"
)

// Repeating tasks (PLAN §6.4). A repeating task is a **seed**: a task carrying an RFC5545
// RRULE in RepeatRule with RepeatSeedID == nil. The seed is a definition, not an actionable
// to-do; the server materializes concrete **occurrence** rows (RepeatSeedID = seed.ID) over
// a rolling window. This file is the one place RRULEs are parsed — used by the client for
// the seed's next-occurrence preview and by the server cron to materialize occurrences, so
// both sides agree on the schedule.
//
// RRULE stays a tasks-only concept; habits use structured cadences instead (§6.5).

// ErrInvalidRepeatRule wraps any malformed RRULE.
var ErrInvalidRepeatRule = errors.New("invalid repeat rule")

// repeatAnchorRef is an arbitrary fixed instant used only to validate a rule's shape (the
// anchor doesn't affect whether an RRULE parses).
var repeatAnchorRef = time.Date(2000, 1, 1, 9, 0, 0, 0, time.UTC)

// buildRRule parses a stored repeat_rule string with `anchor` as its DTSTART. A leading
// "RRULE:" prefix and an optional DTSTART line are both tolerated by the underlying parser.
func buildRRule(rule string, anchor time.Time) (*rrule.RRule, error) {
	if strings.TrimSpace(rule) == "" {
		return nil, errors.Join(ErrInvalidRepeatRule, errors.New("empty rule"))
	}
	opt, err := rrule.StrToROption(rule)
	if err != nil {
		return nil, errors.Join(ErrInvalidRepeatRule, err)
	}
	opt.Dtstart = anchor.UTC().Truncate(time.Second)
	r, err := rrule.NewRRule(*opt)
	if err != nil {
		return nil, errors.Join(ErrInvalidRepeatRule, err)
	}
	return r, nil
}

// ValidateRepeatRule reports whether rule is a well-formed RRULE (or nil/empty for a
// non-repeating task). Used on the task write path, client and server.
func ValidateRepeatRule(rule *string) error {
	if rule == nil || strings.TrimSpace(*rule) == "" {
		return nil
	}
	_, err := buildRRule(*rule, repeatAnchorRef)
	return err
}

// RepeatAnchor is the DTSTART for a seed's schedule: its due date when set (so occurrences
// keep the same time-of-day), else its creation instant as a fallback.
func RepeatAnchor(seed *Task) time.Time {
	if seed.DueAt != nil {
		return *seed.DueAt
	}
	return seed.CreatedAt
}

// NextOccurrence returns the first occurrence strictly after `after`, or nil when the rule
// is exhausted (a COUNT/UNTIL bound is reached). Powers the seed's "next: …" preview,
// which is all a client with no server configured can show (PLAN §6.4).
func NextOccurrence(rule string, anchor, after time.Time) (*time.Time, error) {
	r, err := buildRRule(rule, anchor)
	if err != nil {
		return nil, err
	}
	next := r.After(after.UTC(), false)
	if next.IsZero() {
		return nil, nil
	}
	next = next.UTC()
	return &next, nil
}

// LatestOccurrence returns the most recent occurrence at or before `at`, or nil when the
// schedule hasn't started yet (its first occurrence is still in the future) or is exhausted.
// It answers "which occurrence is current right now?" for just-in-time materialization
// (PLAN §6.4), and powers a seed's next/current-occurrence reasoning without enumerating.
func LatestOccurrence(rule string, anchor, at time.Time) (*time.Time, error) {
	r, err := buildRRule(rule, anchor)
	if err != nil {
		return nil, err
	}
	prev := r.Before(at.UTC(), true) // inclusive: an occurrence exactly at `at` counts
	if prev.IsZero() {
		return nil, nil
	}
	prev = prev.UTC()
	return &prev, nil
}

// --- natural-language recurrence -----------------------------------------
//
// ParseRepeatPhrase turns a typed cadence — "every monday", "every 2 weeks", "the third
// wednesday of the month", "weekdays until aug 1" — into an RRULE (PLAN §6.4). The date
// library (olebedev/when) only resolves single instants, so recurrence gets its own small
// grammar here, shared by every platform through the bridge. An unrecognized phrase returns
// ("", nil) so the UI can show inline "couldn't read that" feedback, exactly like the date
// field. "Times per period" phrases ("twice a week") are deliberately rejected: they have no
// fixed days and belong to habit cadences (§6.5), not a task RRULE.

var (
	reRepeatSpaces = regexp.MustCompile(`\s+`)
	reRepeatVerb   = regexp.MustCompile(`^(?:repeats|repeat|repeating)\s+`)
	reRepeatToken  = regexp.MustCompile(`[a-z0-9]+`)
	reRepeatDigits = regexp.MustCompile(`\b(\d+)\b`)
	reRepeatCount  = regexp.MustCompile(`\s+(?:for\s+)?(\d+)\s*(?:times|x)$`)
	reRepeatUntil  = regexp.MustCompile(`\s+until\s+(.+)$`)
	// "times per period" phrases ("twice a week", "3 times a month", "5 per week") describe
	// a count, not a schedule with fixed days — they're habit cadences (§6.5), not RRULEs.
	reTimesPerPeriod = regexp.MustCompile(`\b(?:once|twice|thrice)\b|\btimes?\s+(?:a|an|per|each)\b|\bper\s+(?:minute|hour|day|week|month|year)s?\b`)
	reDayOrdinal     = regexp.MustCompile(`^(\d{1,2})(?:st|nd|rd|th)$`)  // "15th" — suffix required
	reDayNumber      = regexp.MustCompile(`^(\d{1,2})(?:st|nd|rd|th)?$`) // "4" or "4th"
	reWeekdayRange   = regexp.MustCompile(`\b([a-z]+)\s*(?:to|through|-)\s*([a-z]+)\b`)
)

// weekdayCode maps day-name synonyms to their RFC5545 code; weekdayOrder gives Mon..Sun rank.
var (
	weekdayCode = map[string]string{
		"monday": "MO", "mon": "MO", "mondays": "MO",
		"tuesday": "TU", "tue": "TU", "tues": "TU", "tuesdays": "TU",
		"wednesday": "WE", "wed": "WE", "weds": "WE", "wednesdays": "WE",
		"thursday": "TH", "thu": "TH", "thur": "TH", "thurs": "TH", "thursdays": "TH",
		"friday": "FR", "fri": "FR", "fridays": "FR",
		"saturday": "SA", "sat": "SA", "saturdays": "SA",
		"sunday": "SU", "sun": "SU", "sundays": "SU",
	}
	weekdayOrder = map[string]int{"MO": 0, "TU": 1, "WE": 2, "TH": 3, "FR": 4, "SA": 5, "SU": 6}
	weekdayByPos = []string{"MO", "TU", "WE", "TH", "FR", "SA", "SU"}
)

// monthNumber maps month-name synonyms to 1..12.
var monthNumber = map[string]int{
	"january": 1, "jan": 1, "february": 2, "feb": 2, "march": 3, "mar": 3,
	"april": 4, "apr": 4, "may": 5, "june": 6, "jun": 6, "july": 7, "jul": 7,
	"august": 8, "aug": 8, "september": 9, "sep": 9, "sept": 9, "october": 10, "oct": 10,
	"november": 11, "nov": 11, "december": 12, "dec": 12,
}

// ordinalWord maps an ordinal (word or "1st"…) to its BYDAY set-position; "last" is -1.
var ordinalWord = map[string]int{
	"first": 1, "1st": 1, "second": 2, "2nd": 2, "third": 3, "3rd": 3,
	"fourth": 4, "4th": 4, "fifth": 5, "5th": 5, "last": -1,
}

// numberWord maps small spelled-out numbers used as intervals.
var numberWord = map[string]int{
	"two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
	"eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
}

// ParseRepeatPhrase parses text into an RRULE, or returns "" when unrecognized. ref anchors
// any trailing "until <phrase>" bound (pass the user's local now).
func ParseRepeatPhrase(text string, ref time.Time) (string, error) {
	s := normalizeRepeat(text)
	if s == "" {
		return "", nil
	}
	if reTimesPerPeriod.MatchString(s) {
		return "", nil // a habit cadence, not a task RRULE
	}
	s, bounds := extractRepeatBounds(s, ref)
	body := parseRepeatBody(s)
	if body == nil {
		return "", nil
	}
	rule := strings.Join(append(body, bounds...), ";")
	// Defensive: never hand back a rule the core itself won't accept.
	if err := ValidateRepeatRule(&rule); err != nil {
		return "", nil
	}
	return rule, nil
}

func normalizeRepeat(text string) string {
	s := strings.ToLower(strings.TrimSpace(text))
	s = strings.NewReplacer("–", "-", "—", "-").Replace(s)
	s = reRepeatSpaces.ReplaceAllString(s, " ")
	s = reRepeatVerb.ReplaceAllString(s, "")
	return strings.TrimSpace(s)
}

// extractRepeatBounds peels a trailing COUNT ("… 10 times") or UNTIL ("… until aug 1")
// clause off the phrase, returning the remaining recurrence body and the RRULE bound parts.
func extractRepeatBounds(s string, ref time.Time) (string, []string) {
	var parts []string
	if m := reRepeatCount.FindStringSubmatch(s); m != nil {
		if n, err := strconv.Atoi(m[1]); err == nil && n > 0 {
			parts = append(parts, "COUNT="+strconv.Itoa(n))
			s = strings.TrimSpace(reRepeatCount.ReplaceAllString(s, ""))
		}
	}
	if m := reRepeatUntil.FindStringSubmatch(s); m != nil {
		if res, err := dates.Parse(m[1], ref); err == nil && res != nil {
			// UNTIL is an inclusive bound; pin it to the end of the named day so an
			// occurrence anywhere on that date still counts, independent of the ref's
			// time-of-day.
			y, mo, d := res.At.UTC().Date()
			until := time.Date(y, mo, d, 23, 59, 59, 0, time.UTC)
			parts = append(parts, "UNTIL="+until.Format("20060102T150405Z"))
			s = strings.TrimSpace(reRepeatUntil.ReplaceAllString(s, ""))
		}
	}
	return s, parts
}

// parseRepeatBody maps the frequency portion of a phrase to ordered RRULE parts, most
// specific patterns first (ordinal-of-month and calendar dates before plain frequency).
func parseRepeatBody(s string) []string {
	toks := reRepeatToken.FindAllString(s, -1)
	monthCtx := containsWord(s, `months?`) || strings.Contains(s, "monthly")

	if monthCtx {
		if part := ordinalWeekdayOfMonth(s, toks); part != nil {
			return part
		}
		if part := dayOfMonth(s, toks); part != nil {
			return part
		}
	}
	if part := yearlyDate(s, toks); part != nil {
		return part
	}
	if part := weekdayRule(s, toks); part != nil {
		return part
	}
	return plainFrequency(s)
}

// ordinalWeekdayOfMonth handles "the third wednesday of the month", "last friday of every
// other month" → FREQ=MONTHLY;[INTERVAL=n;]BYDAY=<pos><code>.
func ordinalWeekdayOfMonth(s string, toks []string) []string {
	for i, tk := range toks {
		pos, ok := ordinalWord[tk]
		if !ok {
			continue
		}
		for j := i + 1; j < len(toks) && j <= i+3; j++ {
			code, ok := weekdayCode[toks[j]]
			if !ok {
				continue
			}
			parts := []string{"FREQ=MONTHLY"}
			if n := repeatInterval(s); n > 1 {
				parts = append(parts, "INTERVAL="+strconv.Itoa(n))
			}
			return append(parts, fmt.Sprintf("BYDAY=%d%s", pos, code))
		}
	}
	return nil
}

// dayOfMonth handles "on the 15th", "the 1st and 15th of the month", "the last day of the
// month" → FREQ=MONTHLY;[INTERVAL=n;]BYMONTHDAY=….
func dayOfMonth(s string, toks []string) []string {
	var days []int
	seen := map[int]bool{}
	if containsWord(s, `last day`) && !seen[-1] {
		days, seen[-1] = append(days, -1), true
	}
	for _, tk := range toks {
		m := reDayOrdinal.FindStringSubmatch(tk)
		if m == nil {
			continue
		}
		if d, _ := strconv.Atoi(m[1]); d >= 1 && d <= 31 && !seen[d] {
			days, seen[d] = append(days, d), true
		}
	}
	if len(days) == 0 {
		return nil
	}
	parts := []string{"FREQ=MONTHLY"}
	if n := repeatInterval(s); n > 1 {
		parts = append(parts, "INTERVAL="+strconv.Itoa(n))
	}
	return append(parts, "BYMONTHDAY="+joinInts(days))
}

// yearlyDate handles "every july 4", "annually on december 25th", "every march" →
// FREQ=YEARLY;BYMONTH=m[;BYMONTHDAY=d].
func yearlyDate(s string, toks []string) []string {
	monthIdx, month := -1, 0
	for i, tk := range toks {
		if m, ok := monthNumber[tk]; ok {
			monthIdx, month = i, m
			break
		}
	}
	if month == 0 {
		return nil
	}
	parts := []string{"FREQ=YEARLY", "BYMONTH=" + strconv.Itoa(month)}
	for j := monthIdx - 1; j <= monthIdx+2; j++ {
		if j < 0 || j >= len(toks) || j == monthIdx {
			continue
		}
		if m := reDayNumber.FindStringSubmatch(toks[j]); m != nil {
			if d, _ := strconv.Atoi(m[1]); d >= 1 && d <= 31 {
				return append(parts, "BYMONTHDAY="+strconv.Itoa(d))
			}
		}
	}
	return parts
}

// weekdayRule handles weekday shortcuts ("weekdays", "weekends"), ranges ("monday to
// friday"), and explicit lists ("every monday and thursday") → FREQ=WEEKLY;…;BYDAY=….
func weekdayRule(s string, toks []string) []string {
	var codes []string
	switch {
	case strings.Contains(s, "weekday") || strings.Contains(s, "work day") || strings.Contains(s, "workday"):
		codes = []string{"MO", "TU", "WE", "TH", "FR"}
	case strings.Contains(s, "weekend"):
		codes = []string{"SA", "SU"}
	default:
		if r := weekdayRange(s); r != nil {
			codes = r
		} else {
			codes = weekdaysIn(toks)
		}
	}
	if len(codes) == 0 {
		return nil
	}
	parts := []string{"FREQ=WEEKLY"}
	if n := repeatInterval(s); n > 1 {
		parts = append(parts, "INTERVAL="+strconv.Itoa(n))
	}
	return append(parts, "BYDAY="+strings.Join(codes, ","))
}

// weekdayRange expands "monday to friday" / "mon-thu" into the inclusive weekday span.
func weekdayRange(s string) []string {
	m := reWeekdayRange.FindStringSubmatch(s)
	if m == nil {
		return nil
	}
	from, ok1 := weekdayCode[m[1]]
	to, ok2 := weekdayCode[m[2]]
	if !ok1 || !ok2 || weekdayOrder[from] > weekdayOrder[to] {
		return nil
	}
	var codes []string
	for i := weekdayOrder[from]; i <= weekdayOrder[to]; i++ {
		codes = append(codes, weekdayByPos[i])
	}
	return codes
}

// weekdaysIn collects the distinct weekday codes named in the tokens, in Mon..Sun order.
func weekdaysIn(toks []string) []string {
	seen := map[string]bool{}
	for _, tk := range toks {
		if code, ok := weekdayCode[tk]; ok {
			seen[code] = true
		}
	}
	if len(seen) == 0 {
		return nil
	}
	codes := make([]string, 0, len(seen))
	for code := range seen {
		codes = append(codes, code)
	}
	sort.Slice(codes, func(i, j int) bool { return weekdayOrder[codes[i]] < weekdayOrder[codes[j]] })
	return codes
}

// plainFrequency handles bare cadences and their common single-word synonyms.
func plainFrequency(s string) []string {
	switch {
	case strings.Contains(s, "fortnight"), strings.Contains(s, "biweekly"):
		return []string{"FREQ=WEEKLY", "INTERVAL=2"}
	case strings.Contains(s, "quarterly"):
		return []string{"FREQ=MONTHLY", "INTERVAL=3"}
	case strings.Contains(s, "bimonthly"):
		return []string{"FREQ=MONTHLY", "INTERVAL=2"}
	case regexp.MustCompile(`semi-?\s?annual`).MatchString(s):
		return []string{"FREQ=MONTHLY", "INTERVAL=6"}
	case strings.Contains(s, "biennial"):
		return []string{"FREQ=YEARLY", "INTERVAL=2"}
	case strings.Contains(s, "hourly"):
		return withInterval("HOURLY", s)
	case strings.Contains(s, "daily"):
		return withInterval("DAILY", s)
	case strings.Contains(s, "weekly"):
		return withInterval("WEEKLY", s)
	case strings.Contains(s, "monthly"):
		return withInterval("MONTHLY", s)
	case strings.Contains(s, "yearly"), strings.Contains(s, "annual"):
		return withInterval("YEARLY", s)
	}
	freq := ""
	switch {
	case containsWord(s, `minutes?|mins?|min`):
		freq = "MINUTELY"
	case containsWord(s, `hours?|hrs?|hr`):
		freq = "HOURLY"
	case containsWord(s, `days?`):
		freq = "DAILY"
	case containsWord(s, `weeks?`):
		freq = "WEEKLY"
	case containsWord(s, `months?`):
		freq = "MONTHLY"
	case containsWord(s, `years?`):
		freq = "YEARLY"
	}
	if freq == "" {
		return nil
	}
	return withInterval(freq, s)
}

func withInterval(freq, s string) []string {
	parts := []string{"FREQ=" + freq}
	if n := repeatInterval(s); n > 1 {
		parts = append(parts, "INTERVAL="+strconv.Itoa(n))
	}
	return parts
}

// repeatInterval reads the recurrence multiplier: "every other" → 2, a digit, or a spelled
// number; default 1.
func repeatInterval(s string) int {
	if strings.Contains(s, "other") {
		return 2
	}
	if m := reRepeatDigits.FindStringSubmatch(s); m != nil {
		if n, _ := strconv.Atoi(m[1]); n > 0 {
			return n
		}
	}
	for word, n := range numberWord {
		if containsWord(s, word) {
			return n
		}
	}
	return 1
}

// containsWord reports whether the pattern matches at word boundaries in s.
func containsWord(s, pattern string) bool {
	return regexp.MustCompile(`\b(?:` + pattern + `)\b`).MatchString(s)
}

func joinInts(xs []int) string {
	parts := make([]string, len(xs))
	for i, x := range xs {
		parts[i] = strconv.Itoa(x)
	}
	return strings.Join(parts, ",")
}
