// Package calendar parses and expands ICS feeds into concrete CalendarEvent occurrences. It runs
// on the client on every platform (PLAN §E2EE): moving expansion off the server is what lets the
// client encrypt event content before pushing it, so the server never sees a plaintext title,
// location, or description — nor the feed URL, which is itself a bearer secret.
//
// This is the pure, offline half — parsing and recurrence expansion. Fetching (native HTTP vs. the
// web CORS proxy) and reconciliation against the local store live in the shells/store, so this
// package has no network or database dependency and is exhaustively unit-testable from ICS text.
package calendar

import (
	"fmt"
	"io"
	"strings"
	"time"

	"companion/core/domain"

	ical "github.com/emersion/go-ical"
	"github.com/google/uuid"
	"github.com/teambition/rrule-go"
)

// Window bounds recurrence expansion to ±1y around now, so an unbounded weekly rule yields a
// finite, storable set of occurrences (PLAN §6.7).
const Window = 365 * 24 * time.Hour

// MaxICSBytes caps a fetched ICS body to guard against a hostile or runaway feed.
const MaxICSBytes = 10 << 20 // 10 MiB

// ns namespaces the deterministic (UUIDv5) event ids so re-fetches upsert the same occurrence in
// place rather than duplicating it, and so two devices expanding the same feed agree on ids. The
// value is an arbitrary fixed UUID (matching the server's historical namespace so ids are stable
// across the client-fetch migration).
var ns = uuid.MustParse("1b4e28ba-2fa1-11d2-883f-0016d3cca427")

// ParseAndExpand decodes an ICS stream and expands every event over [now-Window, now+Window]. A
// malformed individual event is skipped rather than failing the whole feed.
func ParseAndExpand(r io.Reader, feedID string, now time.Time) ([]*domain.CalendarEvent, error) {
	cal, err := ical.NewDecoder(r).Decode()
	if err != nil {
		return nil, fmt.Errorf("decode ics: %w", err)
	}
	windowStart := now.Add(-Window)
	windowEnd := now.Add(Window)

	var out []*domain.CalendarEvent
	for _, ev := range cal.Events() {
		base, allDay, dur, rrl, err := parseEvent(&ev)
		if err != nil {
			continue
		}
		starts := expandStarts(base, rrl, exDates(&ev), windowStart, windowEnd)
		for _, st := range starts {
			out = append(out, buildOccurrence(feedID, &ev, st, dur, allDay))
		}
	}
	return out, nil
}

// NormalizeFeedURL rewrites the webcal(s):// scheme calendar apps hand out to https://, which
// HTTP clients understand.
func NormalizeFeedURL(raw string) string {
	u := strings.TrimSpace(raw)
	switch {
	case strings.HasPrefix(strings.ToLower(u), "webcals://"):
		return "https://" + u[len("webcals://"):]
	case strings.HasPrefix(strings.ToLower(u), "webcal://"):
		return "https://" + u[len("webcal://"):]
	}
	return u
}

// exDates returns the excluded recurrence instants declared by a VEVENT's EXDATE properties (a
// single instance the user deleted from a repeating event). Unparseable values are skipped.
func exDates(ev *ical.Event) []time.Time {
	var out []time.Time
	for _, p := range ev.Props[ical.PropExceptionDates] {
		for _, v := range strings.Split(p.Value, ",") {
			cp := p
			cp.Value = strings.TrimSpace(v)
			if t, err := cp.DateTime(time.UTC); err == nil {
				out = append(out, t.UTC())
			}
		}
	}
	return out
}

// parseEvent extracts the anchor start, all-day flag, duration, and RRULE string from a VEVENT.
func parseEvent(ev *ical.Event) (start time.Time, allDay bool, dur time.Duration, rruleStr string, err error) {
	start, err = ev.DateTimeStart(time.UTC)
	if err != nil {
		return time.Time{}, false, 0, "", err
	}
	if p := ev.Props.Get(ical.PropDateTimeStart); p != nil && p.Params.Get(ical.ParamValue) == "DATE" {
		allDay = true
	}
	if end, err := ev.DateTimeEnd(time.UTC); err == nil && !end.IsZero() {
		dur = end.Sub(start)
	}
	if p := ev.Props.Get(ical.PropRecurrenceRule); p != nil {
		rruleStr = p.Value
	}
	return start, allDay, dur, rruleStr, nil
}

// expandStarts returns every occurrence start within [from, to]. A non-recurring event yields its
// single start if in range; a recurring one is expanded with rrule-go.
func expandStarts(base time.Time, rruleStr string, exdates []time.Time, from, to time.Time) []time.Time {
	if rruleStr == "" {
		if !base.Before(from) && !base.After(to) {
			return []time.Time{base}
		}
		return nil
	}
	opt, err := rrule.StrToROption(rruleStr)
	if err != nil {
		if !base.Before(from) && !base.After(to) {
			return []time.Time{base}
		}
		return nil
	}
	opt.Dtstart = base
	set := &rrule.Set{}
	if r, err := rrule.NewRRule(*opt); err == nil {
		set.RRule(r)
	} else {
		return nil
	}
	for _, ex := range exdates {
		set.ExDate(ex)
	}
	return set.Between(from, to, true)
}

// buildOccurrence materializes one CalendarEvent for a start instant, with a deterministic id so
// re-fetches (and other devices) upsert in place. The event is marked dirty so the sync engine
// pushes it (encrypted).
func buildOccurrence(feedID string, ev *ical.Event, start time.Time, dur time.Duration, allDay bool) *domain.CalendarEvent {
	uid := propText(ev, ical.PropUID)
	e := &domain.CalendarEvent{
		ID:       EventID(feedID, uid, start),
		FeedID:   feedID,
		ICSUID:   uid,
		Title:    propText(ev, ical.PropSummary),
		StartsAt: start.UTC(),
		AllDay:   allDay,
		Dirty:    true,
	}
	if dur > 0 {
		end := start.Add(dur).UTC()
		e.EndsAt = &end
	}
	if loc := propText(ev, ical.PropLocation); loc != "" {
		e.Location = &loc
	}
	if desc := propText(ev, ical.PropDescription); desc != "" {
		e.Description = &desc
	}
	return e
}

// propText reads a text property, treating an absent or malformed value as empty.
func propText(ev *ical.Event, name string) string {
	v, err := ev.Props.Text(name)
	if err != nil {
		return ""
	}
	return v
}

// EventID is the deterministic UUIDv5 of feed|uid|occurrence-start.
func EventID(feedID, uid string, start time.Time) string {
	return uuid.NewSHA1(ns, []byte(feedID+"|"+uid+"|"+start.UTC().Format(time.RFC3339))).String()
}

// Changed reports whether a freshly-expanded occurrence differs from a stored one in any
// user-visible field (ignoring created_at/updated_at/version/dirty/seq), so a quiet feed produces
// no sync churn.
func Changed(old, fresh *domain.CalendarEvent) bool {
	if old.Title != fresh.Title || old.ICSUID != fresh.ICSUID || old.AllDay != fresh.AllDay {
		return true
	}
	if !old.StartsAt.Equal(fresh.StartsAt) {
		return true
	}
	if (old.EndsAt == nil) != (fresh.EndsAt == nil) {
		return true
	}
	if old.EndsAt != nil && fresh.EndsAt != nil && !old.EndsAt.Equal(*fresh.EndsAt) {
		return true
	}
	return derefStr(old.Location) != derefStr(fresh.Location) || derefStr(old.Description) != derefStr(fresh.Description)
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
