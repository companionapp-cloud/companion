package calendar

import (
	"bytes"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"companion/core/domain"

	ical "github.com/emersion/go-ical"
	"github.com/google/uuid"
	"github.com/teambition/rrule-go"
)

// This file is the write half of the calendar package (PLAN-caldav.md §3): building a new calendar
// object and patching an existing one. The rule throughout is to touch only the properties
// Companion models and leave everything else exactly as the provider served it — attendees,
// alarms, time zones and X- properties all survive an edit made here.

// ProductID identifies Companion as the authoring client in objects it creates.
const ProductID = "-//Companion//Calendar//EN"

var (
	// ErrNoEvent means the ICS holds no VEVENT to edit.
	ErrNoEvent = errors.New("calendar object has no event")
	// ErrRecurringTimeEdit is returned when moving a repeating event to another day would break
	// a repeat rule Companion cannot rewrite (see Repeat.Custom) — "the 2nd Tuesday of the month"
	// moved to a Thursday has no obvious meaning. Its time of day can still be changed.
	ErrRecurringTimeEdit = errors.New("this event has a custom repeat, so it can't be moved to another day from here — change its repeat first, or edit it in your calendar app")
	// ErrRecurringAllDayToggle is returned when switching a repeating event between all-day and timed.
	ErrRecurringAllDayToggle = errors.New("a repeating event can't be switched between all-day and timed — remove its repeat first")
	// ErrInvalidEventTimes means an end that is not after its start.
	ErrInvalidEventTimes = errors.New("an event must end after it starts")
)

// EventFields are the properties of a new event. For an all-day event StartsAt is midnight UTC of
// the first day and EndsAt midnight UTC of the day AFTER the last one (the exclusive end iCalendar
// uses) — the same shape expansion produces, so what is written reads back identically.
type EventFields struct {
	Title       string     `json:"title"`
	StartsAt    time.Time  `json:"startsAt"`
	EndsAt      *time.Time `json:"endsAt,omitempty"`
	AllDay      bool       `json:"allDay"`
	Location    *string    `json:"location,omitempty"`
	Description *string    `json:"description,omitempty"`
	// Repeat makes the event recur; nil (or freq "none") is a one-off.
	Repeat *Repeat `json:"repeat,omitempty"`
}

// Repeat frequencies.
const (
	RepeatNone    = "none"
	RepeatDaily   = "daily"
	RepeatWeekly  = "weekly"
	RepeatMonthly = "monthly"
	RepeatYearly  = "yearly"
)

// Repeat is the part of a recurrence rule Companion can author: every N days/weeks/months/years
// from the event's own start, optionally until a last day. Rules that say more than that — a
// count, "the last Friday", several weekdays — are reported as Custom: shown, preserved, and
// replaceable with a simple rule, but not editable piece by piece.
type Repeat struct {
	Freq     string `json:"freq"`
	Interval int    `json:"interval,omitempty"`
	// Until is the last day the event may occur on, as a date marker (midnight UTC of that day).
	Until *time.Time `json:"until,omitempty"`
	// Custom is set when reading a rule with parts Companion does not model. Ignored on write.
	Custom bool `json:"custom,omitempty"`
}

// EventPatch is a partial edit; nil fields are left untouched. An empty Location or Description
// removes the property. StartsAt, EndsAt and AllDay travel together: setting any of them rewrites
// the event's time, and a nil EndsAt then means "keep the current duration".
type EventPatch struct {
	Title       *string    `json:"title,omitempty"`
	StartsAt    *time.Time `json:"startsAt,omitempty"`
	EndsAt      *time.Time `json:"endsAt,omitempty"`
	AllDay      *bool      `json:"allDay,omitempty"`
	Location    *string    `json:"location,omitempty"`
	Description *string    `json:"description,omitempty"`
	// Repeat replaces the recurrence rule; freq "none" removes it. Nil leaves it untouched.
	Repeat *Repeat `json:"repeat,omitempty"`
	// OccurrenceStart is the start of the occurrence the user was looking at when they made the
	// edit. For a repeating event StartsAt/EndsAt describe where THAT occurrence should go, and the
	// series is moved to match. Set by the bridge from the stored occurrence, never by the UI.
	OccurrenceStart *time.Time `json:"-"`
}

// touchesTime reports whether the patch asks for a different time.
func (p EventPatch) touchesTime() bool {
	return p.StartsAt != nil || p.EndsAt != nil || p.AllDay != nil
}

// ObjectID is the deterministic UUIDv5 of feed|uid, so every device that pulls the same calendar
// produces the same CalendarObject row and they converge instead of duplicating.
func ObjectID(feedID, uid string) string {
	return uuid.NewSHA1(ns, []byte("object|"+feedID+"|"+uid)).String()
}

// NewUID mints the UID of a locally-created event.
func NewUID() string { return strings.ToUpper(uuid.NewString()) }

// NewObject renders a single-event calendar object.
func NewObject(uid string, f EventFields, now time.Time) (string, error) {
	if strings.TrimSpace(uid) == "" {
		return "", errors.New("uid is required")
	}
	ev := ical.NewEvent()
	ev.Props.SetText(ical.PropUID, uid)
	ev.Props.SetDateTime(ical.PropDateTimeStamp, now.UTC())
	ev.Props.SetDateTime(ical.PropCreated, now.UTC())
	ev.Props.SetDateTime(ical.PropLastModified, now.UTC())
	setInt(ev.Props, ical.PropSequence, 0)
	ev.Props.SetText(ical.PropSummary, f.Title)
	if err := setTimes(ev, f.StartsAt, f.EndsAt, f.AllDay, time.UTC); err != nil {
		return "", err
	}
	setOptionalText(ev.Props, ical.PropLocation, f.Location)
	setOptionalText(ev.Props, ical.PropDescription, f.Description)
	if err := setRepeat(ev, f.Repeat, f.AllDay, time.UTC); err != nil {
		return "", err
	}

	cal := ical.NewCalendar()
	cal.Props.SetText(ical.PropVersion, "2.0")
	cal.Props.SetText(ical.PropProductID, ProductID)
	cal.Children = append(cal.Children, ev.Component)
	return encode(cal)
}

// ApplyEdit patches the master event of a calendar object and returns the new ICS. Text changes to
// a repeating event apply to the whole series; a time change to one is refused.
func ApplyEdit(ics string, p EventPatch, now time.Time) (string, error) {
	cal, err := decode(ics)
	if err != nil {
		return "", err
	}
	ev := masterEvent(cal)
	if ev == nil {
		return "", ErrNoEvent
	}
	loc := eventLocation(ev)
	recurring := isRecurring(ev)
	if p.touchesTime() {
		start, allDay, dur, _, err := parseEvent(ev)
		if err != nil {
			return "", err
		}
		newAllDay := allDay
		if p.AllDay != nil {
			newAllDay = *p.AllDay
		}
		if recurring && newAllDay != allDay && !(p.Repeat != nil && p.Repeat.Freq == RepeatNone) {
			return "", ErrRecurringAllDayToggle
		}
		// What the user edited is one occurrence; what gets written is the series anchor. For a
		// one-off event the two are the same thing.
		occ := start
		if recurring && p.OccurrenceStart != nil {
			occ = p.OccurrenceStart.UTC()
		}
		newOcc := occ
		if p.StartsAt != nil {
			newOcc = p.StartsAt.UTC()
		}
		newDur := dur
		switch {
		case p.EndsAt != nil:
			newDur = p.EndsAt.UTC().Sub(newOcc)
			if newDur <= 0 {
				return "", ErrInvalidEventTimes
			}
		case newAllDay != allDay:
			newDur = 0 // setTimes picks the natural length for the new kind
		}
		if newAllDay {
			loc = time.UTC // a date has no zone
		}
		newStart := shiftWallClock(start, occ, newOcc, loc)
		// Only rewrite DTSTART/DTEND when something actually moves, so renaming an event keeps
		// byte-for-byte the start its own calendar app wrote.
		moved := !newStart.Equal(start) || newAllDay != allDay || newDur != dur
		if moved {
			if recurring {
				dayChanged := !sameDay(occ.In(loc), newOcc.In(loc))
				if dayChanged && p.Repeat == nil {
					// BYDAY=MO no longer describes a series that now starts on a Wednesday. A
					// simple rule is rewritten to follow its new start; a custom one can't be.
					cur := readRepeat(ev, loc)
					if cur != nil && cur.Custom {
						return "", ErrRecurringTimeEdit
					}
					p.Repeat = cur
				}
				// Exclusions and overrides are addressed by the instants they replace; move them
				// with the series or every deleted occurrence comes back.
				shiftRecurrenceAnchors(cal, ev, occ, newOcc, loc, newAllDay)
			}
			var newEnd *time.Time
			if newDur > 0 {
				e := newStart.Add(newDur)
				newEnd = &e
			}
			if err := setTimes(ev, newStart, newEnd, newAllDay, loc); err != nil {
				return "", err
			}
		}
	}
	if p.Repeat != nil {
		_, allDay, _, _, err := parseEvent(ev)
		if err != nil {
			return "", err
		}
		if p.Repeat.Freq == RepeatNone || p.Repeat.Freq == "" {
			// Ending a repeat keeps the occurrence the user was looking at, not the first one from
			// years ago: make it the event.
			if recurring && p.OccurrenceStart != nil && !p.touchesTime() {
				start, _, dur, _, _ := parseEvent(ev)
				newStart := shiftWallClock(start, start, p.OccurrenceStart.UTC(), loc)
				var newEnd *time.Time
				if dur > 0 {
					e := newStart.Add(dur)
					newEnd = &e
				}
				if err := setTimes(ev, newStart, newEnd, allDay, loc); err != nil {
					return "", err
				}
			}
			clearRecurrence(cal, ev)
		} else if err := setRepeat(ev, p.Repeat, allDay, loc); err != nil {
			return "", err
		}
	}
	if p.Title != nil {
		ev.Props.SetText(ical.PropSummary, *p.Title)
	}
	if p.Location != nil {
		setOptionalText(ev.Props, ical.PropLocation, p.Location)
	}
	if p.Description != nil {
		setOptionalText(ev.Props, ical.PropDescription, p.Description)
	}
	touch(ev, now)
	return encode(cal)
}

// ExcludeOccurrence removes one occurrence from a repeating event: an EXDATE on the master, and
// the matching RECURRENCE-ID override dropped if there was one. start is the occurrence's original
// instant for a plain occurrence, or the override's own start for a moved one.
func ExcludeOccurrence(ics string, start time.Time, now time.Time) (string, error) {
	cal, err := decode(ics)
	if err != nil {
		return "", err
	}
	master := masterEvent(cal)
	if master == nil {
		return "", ErrNoEvent
	}
	if !isRecurring(master) {
		return "", errors.New("not a repeating event")
	}
	// If the instant belongs to an override, exclude the instant it replaced and drop the override.
	recurrenceAt := start.UTC()
	kept := cal.Children[:0]
	for _, child := range cal.Children {
		if child.Name == ical.CompEvent && child != master.Component {
			ov := &ical.Event{Component: child}
			if rid, ok := recurrenceID(ov); ok {
				ovStart, err := ov.DateTimeStart(time.UTC)
				if rid.Equal(start.UTC()) || (err == nil && ovStart.UTC().Equal(start.UTC())) {
					recurrenceAt = rid
					continue
				}
			}
		}
		kept = append(kept, child)
	}
	cal.Children = kept

	// EXDATE must use the same value form as DTSTART or some clients ignore it.
	ex := ical.NewProp(ical.PropExceptionDates)
	dtstart := master.Props.Get(ical.PropDateTimeStart)
	switch {
	case dtstart != nil && dtstart.ValueType() == ical.ValueDate:
		ex.SetDate(recurrenceAt)
	case dtstart != nil && dtstart.Params.Get(ical.PropTimezoneID) != "":
		if loc, err := time.LoadLocation(dtstart.Params.Get(ical.PropTimezoneID)); err == nil {
			ex.SetDateTime(recurrenceAt.In(loc))
		} else {
			ex.SetDateTime(recurrenceAt)
		}
	default:
		ex.SetDateTime(recurrenceAt)
	}
	master.Props.Add(ex)
	touch(master, now)
	return encode(cal)
}

// ObjectInfo is what the store needs to know about a calendar object without keeping it parsed.
type ObjectInfo struct {
	UID       string
	Title     string
	Recurring bool
	// Repeat describes the recurrence rule for the editor; nil for a one-off event.
	Repeat *Repeat
}

// InspectObject reads the UID and recurrence flag of a calendar object.
func InspectObject(ics string) (ObjectInfo, error) {
	cal, err := decode(ics)
	if err != nil {
		return ObjectInfo{}, err
	}
	ev := masterEvent(cal)
	if ev == nil {
		return ObjectInfo{}, ErrNoEvent
	}
	return ObjectInfo{
		UID: propText(ev, ical.PropUID), Title: propText(ev, ical.PropSummary),
		Recurring: isRecurring(ev), Repeat: readRepeat(ev, eventLocation(ev)),
	}, nil
}

// ExpandObject expands one calendar object into its occurrences within the window, exactly as a
// feed body would be (it IS a one-object feed body).
func ExpandObject(ics, feedID string, now time.Time) ([]*domain.CalendarEvent, error) {
	return ParseAndExpand(strings.NewReader(ics), feedID, now)
}

// SameContent reports whether two calendar objects agree on everything Companion writes: the
// fields of the master event and its exclusions. It decides whether a 412 from the provider is a
// real conflict or just another device having pushed the very same change first.
func SameContent(a, b string) bool {
	sa, errA := contentSignature(a)
	sb, errB := contentSignature(b)
	return errA == nil && errB == nil && sa == sb
}

func contentSignature(ics string) (string, error) {
	cal, err := decode(ics)
	if err != nil {
		return "", err
	}
	ev := masterEvent(cal)
	if ev == nil {
		return "", ErrNoEvent
	}
	start, allDay, dur, rule, err := parseEvent(ev)
	if err != nil {
		return "", err
	}
	var ex []string
	for _, t := range exDates(ev) {
		ex = append(ex, t.UTC().Format(time.RFC3339))
	}
	overrides := 0
	for _, e := range cal.Events() {
		if _, ok := recurrenceID(&e); ok {
			overrides++
		}
	}
	return strings.Join([]string{
		propText(ev, ical.PropSummary), propText(ev, ical.PropLocation), propText(ev, ical.PropDescription),
		start.UTC().Format(time.RFC3339), dur.String(), strconv.FormatBool(allDay), rule,
		strings.Join(ex, ","), strconv.Itoa(overrides),
	}, "\x1f"), nil
}

// ---- helpers -------------------------------------------------------------

func decode(ics string) (*ical.Calendar, error) {
	cal, err := ical.NewDecoder(strings.NewReader(ics)).Decode()
	if err != nil {
		return nil, fmt.Errorf("decode ics: %w", err)
	}
	return cal, nil
}

func encode(cal *ical.Calendar) (string, error) {
	var buf bytes.Buffer
	if err := ical.NewEncoder(&buf).Encode(cal); err != nil {
		return "", fmt.Errorf("encode ics: %w", err)
	}
	return buf.String(), nil
}

// masterEvent returns the VEVENT that defines the object: the one without a RECURRENCE-ID. An
// object holding only overrides (an invitation to a single instance) falls back to the first.
func masterEvent(cal *ical.Calendar) *ical.Event {
	events := cal.Events()
	for i := range events {
		if _, ok := recurrenceID(&events[i]); !ok {
			return &events[i]
		}
	}
	if len(events) > 0 {
		return &events[0]
	}
	return nil
}

// recurrenceID returns the instant an override replaces, if the event is an override.
func recurrenceID(ev *ical.Event) (time.Time, bool) {
	p := ev.Props.Get(ical.PropRecurrenceID)
	if p == nil {
		return time.Time{}, false
	}
	t, err := p.DateTime(time.UTC)
	if err != nil {
		return time.Time{}, false
	}
	return t.UTC(), true
}

func isRecurring(ev *ical.Event) bool {
	return ev.Props.Get(ical.PropRecurrenceRule) != nil || ev.Props.Get(ical.PropRecurrenceDates) != nil
}

// setTimes writes DTSTART/DTEND. A timed event is written in loc — the zone its own calendar app
// gave it, so "9am in Halifax" stays that across a DST change when it repeats — or in UTC when it
// has none. All-day events are VALUE=DATE with the exclusive end iCalendar expects.
func setTimes(ev *ical.Event, start time.Time, end *time.Time, allDay bool, loc *time.Location) error {
	if start.IsZero() {
		return errors.New("a start time is required")
	}
	if end != nil && !end.After(start) {
		return ErrInvalidEventTimes
	}
	ev.Props.Del(ical.PropDateTimeStart)
	ev.Props.Del(ical.PropDateTimeEnd)
	ev.Props.Del(ical.PropDuration)
	if allDay {
		s := start.UTC()
		ev.Props.SetDate(ical.PropDateTimeStart, s)
		e := s.AddDate(0, 0, 1)
		if end != nil {
			e = end.UTC()
		}
		ev.Props.SetDate(ical.PropDateTimeEnd, e)
		return nil
	}
	if loc == nil {
		loc = time.UTC
	}
	ev.Props.SetDateTime(ical.PropDateTimeStart, start.In(loc))
	if end != nil {
		ev.Props.SetDateTime(ical.PropDateTimeEnd, end.In(loc))
	}
	return nil
}

// ---- recurrence ----------------------------------------------------------

// eventLocation is the zone an event's start is expressed in: its TZID when that names a zone
// this system knows, otherwise UTC (which is also right for all-day and floating times).
func eventLocation(ev *ical.Event) *time.Location {
	p := ev.Props.Get(ical.PropDateTimeStart)
	if p == nil || p.ValueType() == ical.ValueDate {
		return time.UTC
	}
	if tzid := p.Params.Get(ical.PropTimezoneID); tzid != "" {
		if loc, err := time.LoadLocation(tzid); err == nil {
			return loc
		}
	}
	return time.UTC
}

func sameDay(a, b time.Time) bool {
	ay, am, ad := a.Date()
	by, bm, bd := b.Date()
	return ay == by && am == bm && ad == bd
}

// shiftWallClock applies to t the change that took one occurrence from `from` to `to`, measured
// on the wall clock in loc: the same number of calendar days, and the new time of day. Adding
// the raw duration instead would drift an hour whenever a DST change falls between the series'
// first occurrence and the one that was edited.
func shiftWallClock(t, from, to time.Time, loc *time.Location) time.Time {
	f, n, m := from.In(loc), to.In(loc), t.In(loc)
	fy, fm, fd := f.Date()
	ny, nm, nd := n.Date()
	days := int(time.Date(ny, nm, nd, 0, 0, 0, 0, time.UTC).Sub(time.Date(fy, fm, fd, 0, 0, 0, 0, time.UTC)).Hours() / 24)
	return time.Date(m.Year(), m.Month(), m.Day()+days, n.Hour(), n.Minute(), n.Second(), 0, loc).UTC()
}

// shiftRecurrenceAnchors moves every EXDATE of the master and every override's RECURRENCE-ID by
// the same wall-clock change as the series, rewriting them in the form the new DTSTART will have.
func shiftRecurrenceAnchors(cal *ical.Calendar, master *ical.Event, from, to time.Time, loc *time.Location, allDay bool) {
	if ex := exDates(master); len(ex) > 0 {
		master.Props.Del(ical.PropExceptionDates)
		for _, t := range ex {
			p := ical.NewProp(ical.PropExceptionDates)
			setAnchor(p, shiftWallClock(t, from, to, loc), loc, allDay)
			master.Props.Add(p)
		}
	}
	for _, e := range cal.Events() {
		if e.Component == master.Component {
			continue
		}
		if rid, ok := recurrenceID(&e); ok {
			p := ical.NewProp(ical.PropRecurrenceID)
			setAnchor(p, shiftWallClock(rid, from, to, loc), loc, allDay)
			e.Props.Set(p)
		}
	}
}

func setAnchor(p *ical.Prop, t time.Time, loc *time.Location, allDay bool) {
	if allDay {
		p.SetDate(t.UTC())
		return
	}
	p.SetDateTime(t.In(loc))
}

// clearRecurrence turns a series back into a single event: no rule, no extra dates, no
// exclusions, and no overrides (they are occurrences of a series that no longer exists).
func clearRecurrence(cal *ical.Calendar, master *ical.Event) {
	master.Props.Del(ical.PropRecurrenceRule)
	master.Props.Del(ical.PropRecurrenceDates)
	master.Props.Del(ical.PropExceptionDates)
	kept := cal.Children[:0]
	for _, child := range cal.Children {
		if child.Name == ical.CompEvent && child != master.Component {
			if _, ok := recurrenceID(&ical.Event{Component: child}); ok {
				continue
			}
		}
		kept = append(kept, child)
	}
	cal.Children = kept
}

var repeatFreqs = map[string]string{RepeatDaily: "DAILY", RepeatWeekly: "WEEKLY", RepeatMonthly: "MONTHLY", RepeatYearly: "YEARLY"}

// setRepeat writes a simple RRULE. It carries no BYDAY/BYMONTHDAY on purpose: without them a rule
// follows DTSTART, so the series keeps meaning "every week on the day it starts" when moved.
func setRepeat(ev *ical.Event, r *Repeat, allDay bool, loc *time.Location) error {
	if r == nil || r.Freq == "" || r.Freq == RepeatNone {
		return nil
	}
	freq, ok := repeatFreqs[r.Freq]
	if !ok {
		return fmt.Errorf("unknown repeat %q", r.Freq)
	}
	rule := "FREQ=" + freq
	if r.Interval > 1 {
		rule += ";INTERVAL=" + strconv.Itoa(r.Interval)
	}
	if r.Until != nil {
		y, m, d := r.Until.UTC().Date()
		if start, err := ev.DateTimeStart(time.UTC); err == nil && time.Date(y, m, d, 23, 59, 59, 0, time.UTC).Before(start) {
			return errors.New("a repeat can't end before the event starts")
		}
		if allDay {
			rule += ";UNTIL=" + time.Date(y, m, d, 0, 0, 0, 0, time.UTC).Format("20060102")
		} else {
			// The whole of that day in the event's zone; UNTIL itself must be UTC when DTSTART is zoned.
			rule += ";UNTIL=" + time.Date(y, m, d, 23, 59, 59, 0, loc).UTC().Format("20060102T150405Z")
		}
	}
	p := ical.NewProp(ical.PropRecurrenceRule)
	p.Value = rule
	ev.Props.Set(p)
	return nil
}

// readRepeat describes an event's recurrence rule, or nil for a one-off. A rule is simple when
// everything it says beyond freq/interval/until merely restates the event's own start.
func readRepeat(ev *ical.Event, loc *time.Location) *Repeat {
	p := ev.Props.Get(ical.PropRecurrenceRule)
	if p == nil {
		if ev.Props.Get(ical.PropRecurrenceDates) != nil {
			return &Repeat{Freq: RepeatNone, Custom: true} // a hand-picked list of dates
		}
		return nil
	}
	opt, err := rrule.StrToROption(p.Value)
	if err != nil {
		return &Repeat{Freq: RepeatNone, Custom: true}
	}
	r := &Repeat{Interval: opt.Interval}
	if r.Interval < 1 {
		r.Interval = 1
	}
	start, err := ev.DateTimeStart(time.UTC)
	if err != nil {
		return &Repeat{Freq: RepeatNone, Custom: true}
	}
	local := start.In(loc)
	restatesWeekday := len(opt.Byweekday) == 0 || (len(opt.Byweekday) == 1 && opt.Byweekday[0].N() == 0 &&
		opt.Byweekday[0].Day() == (int(local.Weekday())+6)%7) // rrule counts Monday as 0
	restatesMonthday := len(opt.Bymonthday) == 0 || (len(opt.Bymonthday) == 1 && opt.Bymonthday[0] == local.Day())
	restatesMonth := len(opt.Bymonth) == 0 || (len(opt.Bymonth) == 1 && opt.Bymonth[0] == int(local.Month()))
	noDay, noMonthday, noMonth := len(opt.Byweekday) == 0, len(opt.Bymonthday) == 0, len(opt.Bymonth) == 0

	switch opt.Freq {
	case rrule.DAILY:
		r.Freq, r.Custom = RepeatDaily, !(noDay && noMonthday && noMonth)
	case rrule.WEEKLY:
		r.Freq, r.Custom = RepeatWeekly, !(restatesWeekday && noMonthday && noMonth)
	case rrule.MONTHLY:
		r.Freq, r.Custom = RepeatMonthly, !(restatesMonthday && noDay && noMonth)
	case rrule.YEARLY:
		r.Freq, r.Custom = RepeatYearly, !(restatesMonth && restatesMonthday && noDay)
	default:
		r.Freq, r.Custom = RepeatNone, true // hourly and finer: not a calendar repeat we offer
	}
	if opt.Count > 0 || len(opt.Bysetpos) > 0 || len(opt.Byyearday) > 0 || len(opt.Byweekno) > 0 ||
		len(opt.Byhour) > 0 || len(opt.Byminute) > 0 || len(opt.Bysecond) > 0 || len(opt.Byeaster) > 0 {
		r.Custom = true
	}
	if !opt.Until.IsZero() {
		y, m, d := opt.Until.In(loc).Date()
		if p := ev.Props.Get(ical.PropDateTimeStart); p != nil && p.ValueType() == ical.ValueDate {
			y, m, d = opt.Until.UTC().Date()
		}
		until := time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
		r.Until = &until
	}
	return r
}

// touch stamps an edit: SEQUENCE up by one, DTSTAMP and LAST-MODIFIED to now. Providers and other
// clients use these to tell a newer revision from an older one.
func touch(ev *ical.Event, now time.Time) {
	seq := 0
	if p := ev.Props.Get(ical.PropSequence); p != nil {
		if n, err := p.Int(); err == nil {
			seq = n
		}
	}
	setInt(ev.Props, ical.PropSequence, seq+1)
	ev.Props.SetDateTime(ical.PropDateTimeStamp, now.UTC())
	ev.Props.SetDateTime(ical.PropLastModified, now.UTC())
}

func setInt(props ical.Props, name string, n int) {
	p := ical.NewProp(name)
	p.Value = strconv.Itoa(n)
	props.Set(p)
}

// setOptionalText sets a text property, or removes it when the value is nil or blank.
func setOptionalText(props ical.Props, name string, v *string) {
	if v == nil || strings.TrimSpace(*v) == "" {
		props.Del(name)
		return
	}
	props.SetText(name, *v)
}
