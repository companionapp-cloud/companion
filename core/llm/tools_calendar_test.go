//go:build !js

package llm

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"companion/core/calendar"
	"companion/core/domain"
	"companion/core/store"
)

// fakeEventWriter records what the calendar write tools ask the host to do.
type fakeEventWriter struct {
	createdIn []string
	created   []calendar.EventFields
	updated   []string
	patches   []calendar.EventPatch
}

func (f *fakeEventWriter) CreateEvent(feedID string, e calendar.EventFields) (string, error) {
	f.createdIn = append(f.createdIn, feedID)
	f.created = append(f.created, e)
	return "new-event", nil
}

func (f *fakeEventWriter) UpdateEvent(id string, p calendar.EventPatch) (string, error) {
	f.updated = append(f.updated, id)
	f.patches = append(f.patches, p)
	return id, nil
}

// inZone runs the rest of a test with the given local timezone, the one the tools read and
// write dates in.
func inZone(t *testing.T, loc *time.Location) {
	t.Helper()
	prev := time.Local
	time.Local = loc
	t.Cleanup(func() { time.Local = prev })
}

var halifaxSummer = time.FixedZone("ADT", -3*3600)

func addCalendar(t *testing.T, s *store.Store, name string, writable bool) *domain.CalendarFeed {
	t.Helper()
	in := store.CreateFeedInput{Name: name}
	if writable {
		acct := "account-1"
		in.Kind, in.AccountID, in.URL = domain.FeedKindCalDAV, &acct, "https://dav.example.com/"+name+"/"
	} else {
		ics := "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n"
		in.ICSText = &ics
	}
	f, err := s.CalendarFeeds.Create(in)
	if err != nil {
		t.Fatalf("create calendar %s: %v", name, err)
	}
	return f
}

// setEvents replaces a calendar's occurrences, the way a feed refresh does.
func setEvents(t *testing.T, s *store.Store, feed *domain.CalendarFeed, evs ...*domain.CalendarEvent) {
	t.Helper()
	for _, e := range evs {
		e.FeedID = feed.ID
		e.ID = calendar.EventID(feed.ID, e.ICSUID, e.StartsAt)
	}
	if _, err := s.CalendarEvents.ReconcileFeedEvents(feed.ID, evs); err != nil {
		t.Fatalf("reconcile %s: %v", feed.Name, err)
	}
}

func at(t time.Time) *time.Time { return &t }

func invokeJSON[T any](t *testing.T, r *Registry, tool, args string) T {
	t.Helper()
	out, err := r.Invoke(context.Background(), tool, json.RawMessage(args))
	if err != nil {
		t.Fatalf("%s(%s): %v", tool, args, err)
	}
	var v T
	if err := json.Unmarshal([]byte(out), &v); err != nil {
		t.Fatalf("%s: decode %s: %v", tool, out, err)
	}
	return v
}

type listEventsResult struct {
	Items     []eventOut `json:"items"`
	Truncated bool       `json:"truncated"`
}

func titles(items []eventOut) []string {
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it.Title
	}
	return out
}

// TestListEventsIsTheUsersDay checks list_events returns exactly the user's local day: events,
// due tasks and dated notes, with all-day items matched by date — Range alone lets the next
// day's all-day event in for anyone west of UTC.
func TestListEventsIsTheUsersDay(t *testing.T) {
	inZone(t, halifaxSummer)
	s := newTestStore(t)
	r := NewStoreRegistry(s)

	work := addCalendar(t, s, "Work", true)
	holidays := addCalendar(t, s, "Holidays", false)
	day := func(d, h, m int) time.Time { return time.Date(2026, 9, d, h, m, 0, 0, halifaxSummer) }
	utcDay := func(d int) time.Time { return time.Date(2026, 9, d, 0, 0, 0, 0, time.UTC) }
	setEvents(t, s, work,
		&domain.CalendarEvent{ICSUID: "standup", Title: "Standup", StartsAt: day(18, 9, 0), EndsAt: at(day(18, 9, 15)), Location: strPtr("Room 4")},
		&domain.CalendarEvent{ICSUID: "late", Title: "Late call", StartsAt: day(18, 23, 30), EndsAt: at(day(19, 0, 30))},
		&domain.CalendarEvent{ICSUID: "tomorrow", Title: "Tomorrow's review", StartsAt: day(19, 10, 0), EndsAt: at(day(19, 11, 0))},
	)
	setEvents(t, s, holidays,
		&domain.CalendarEvent{ICSUID: "holiday", Title: "Company holiday", StartsAt: utcDay(18), EndsAt: at(utcDay(19)), AllDay: true},
		&domain.CalendarEvent{ICSUID: "next-holiday", Title: "Next holiday", StartsAt: utcDay(19), EndsAt: at(utcDay(20)), AllDay: true},
		&domain.CalendarEvent{ICSUID: "offsite", Title: "Offsite", StartsAt: utcDay(17), EndsAt: at(utcDay(20)), AllDay: true},
	)
	due := day(18, 17, 0)
	task, err := s.Tasks.Create(store.CreateTaskInput{Title: "Send invoice", DueAt: &due})
	if err != nil {
		t.Fatal(err)
	}
	date := "2026-09-18"
	if _, err := s.Notes.Create(store.CreateNoteInput{Title: "Friday", Date: &date}); err != nil {
		t.Fatal(err)
	}

	got := invokeJSON[listEventsResult](t, r, "list_events", `{"from":"2026-09-18"}`)
	want := []string{"Offsite", "Company holiday", "Friday", "Standup", "Send invoice", "Late call"}
	if strings.Join(titles(got.Items), "|") != strings.Join(want, "|") {
		t.Fatalf("items = %v, want %v", titles(got.Items), want)
	}
	byTitle := map[string]eventOut{}
	for _, it := range got.Items {
		byTitle[it.Title] = it
	}
	if st := byTitle["Standup"]; st.Start != "2026-09-18T09:00:00-03:00" || st.End != "2026-09-18T09:15:00-03:00" ||
		st.Calendar != "Work" || st.CalendarID != work.ID || st.Location != "Room 4" || st.Kind != "event" {
		t.Errorf("standup = %+v", st)
	}
	if h := byTitle["Company holiday"]; !h.AllDay || h.Start != "2026-09-18" || h.End != "" {
		t.Errorf("single-day all-day event = %+v, want start 2026-09-18 and no end", h)
	}
	if o := byTitle["Offsite"]; o.Start != "2026-09-17" || o.End != "2026-09-19" {
		t.Errorf("multi-day event = %+v, want 2026-09-17 through 2026-09-19 (last day inclusive)", o)
	}
	if tk := byTitle["Send invoice"]; tk.Kind != "task" || tk.Wikilink != "[[task:"+task.ID+"]]" {
		t.Errorf("task item = %+v", tk)
	}

	// Filters narrow the same window.
	if got := invokeJSON[listEventsResult](t, r, "list_events", `{"from":"2026-09-18","query":"room 4"}`); len(got.Items) != 1 || got.Items[0].Title != "Standup" {
		t.Errorf("query filter = %v", titles(got.Items))
	}
	if got := invokeJSON[listEventsResult](t, r, "list_events", `{"from":"2026-09-18","calendarId":"`+work.ID+`"}`); strings.Join(titles(got.Items), "|") != "Standup|Late call" {
		t.Errorf("calendar filter = %v", titles(got.Items))
	}
	if got := invokeJSON[listEventsResult](t, r, "list_events", `{"from":"2026-09-18","kinds":["task","note"]}`); strings.Join(titles(got.Items), "|") != "Friday|Send invoice" {
		t.Errorf("kinds filter = %v", titles(got.Items))
	}
	// A date `to` includes that day; a timestamp window is exact.
	if got := invokeJSON[listEventsResult](t, r, "list_events", `{"from":"2026-09-19","to":"2026-09-19"}`); strings.Join(titles(got.Items), "|") != "Offsite|Next holiday|Late call|Tomorrow's review" {
		t.Errorf("date window = %v", titles(got.Items))
	}
	if got := invokeJSON[listEventsResult](t, r, "list_events", `{"from":"2026-09-18T08:00:00-03:00","to":"2026-09-18T12:00:00-03:00","kinds":["event"]}`); strings.Join(titles(got.Items), "|") != "Offsite|Company holiday|Standup" {
		t.Errorf("timestamp window = %v", titles(got.Items))
	}
	if got := invokeJSON[listEventsResult](t, r, "list_events", `{"from":"2026-09-18","limit":2}`); len(got.Items) != 2 || !got.Truncated {
		t.Errorf("limit: %d items, truncated=%v", len(got.Items), got.Truncated)
	}

	for _, bad := range []string{`{}`, `{"from":"tomorrow"}`, `{"from":"2026-09-18","to":"2026-09-17"}`, `{"from":"2026-01-01","to":"2027-06-01"}`} {
		if _, err := r.Invoke(context.Background(), "list_events", json.RawMessage(bad)); err == nil {
			t.Errorf("list_events(%s) should fail", bad)
		}
	}
}

// addObjectEvent writes an event the way the calendar editor does: a calendar object in a writable
// calendar, with its occurrences derived from it.
func addObjectEvent(t *testing.T, s *store.Store, feed *domain.CalendarFeed, f calendar.EventFields) *domain.CalendarEvent {
	t.Helper()
	uid := calendar.NewUID()
	ics, err := calendar.NewObject(uid, f, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	o := &domain.CalendarObject{ID: calendar.ObjectID(feed.ID, uid), FeedID: feed.ID, UID: uid, ICS: ics, PushState: domain.PushPendingCreate, Recurring: f.Repeat != nil}
	if err := s.CalendarObjects.Put(o); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CalendarEvents.DeriveFromObject(o); err != nil {
		t.Fatal(err)
	}
	ev, err := s.CalendarEvents.GetLive(calendar.EventID(feed.ID, uid, f.StartsAt))
	if err != nil {
		t.Fatalf("derived occurrence: %v", err)
	}
	return ev
}

func TestGetEventAndRenderEvent(t *testing.T) {
	s := newTestStore(t)
	r := NewStoreRegistry(s)
	work := addCalendar(t, s, "Work", true)
	start := time.Now().UTC().Truncate(time.Hour).Add(72 * time.Hour)
	until := time.Date(start.Year()+1, 1, 1, 0, 0, 0, 0, time.UTC)
	ev := addObjectEvent(t, s, work, calendar.EventFields{
		Title: "1:1 with Sam", StartsAt: start, EndsAt: at(start.Add(30 * time.Minute)),
		Description: strPtr("Talk about the roadmap"),
		Repeat:      &calendar.Repeat{Freq: calendar.RepeatWeekly, Until: &until},
	})

	got := invokeJSON[eventOut](t, r, "get_event", `{"id":"`+ev.ID+`"}`)
	if got.Title != "1:1 with Sam" || got.Calendar != "Work" || got.Description != "Talk about the roadmap" {
		t.Errorf("get_event = %+v", got)
	}
	if !got.Editable || !got.Recurring || !got.Pending {
		t.Errorf("flags: editable=%v recurring=%v pending=%v, want all true", got.Editable, got.Recurring, got.Pending)
	}
	if got.Repeat == nil || got.Repeat.Freq != "weekly" || got.Repeat.Until != until.Format(dayLayout) {
		t.Errorf("repeat = %+v", got.Repeat)
	}

	out, err := r.Invoke(context.Background(), "render_event", json.RawMessage(`{"id":"`+ev.ID+`"}`))
	if err != nil || !strings.Contains(out, "1:1 with Sam") || !strings.Contains(out, "Do not repeat") {
		t.Errorf("render_event = %q, %v", out, err)
	}
	for _, tool := range []string{"get_event", "render_event"} {
		if _, err := r.Invoke(context.Background(), tool, json.RawMessage(`{"id":"nope"}`)); err == nil || !strings.Contains(err.Error(), "list_events") {
			t.Errorf("%s with a bad id: %v", tool, err)
		}
	}
}

func TestListCalendars(t *testing.T) {
	s := newTestStore(t)
	r := NewStoreRegistry(s)
	addCalendar(t, s, "Work", true)
	addCalendar(t, s, "Holidays", false)
	got := invokeJSON[[]calendarOut](t, r, "list_calendars", `{}`)
	if len(got) != 2 {
		t.Fatalf("calendars = %+v", got)
	}
	for _, c := range got {
		switch c.Name {
		case "Work":
			if !c.Writable || c.Kind != "account" {
				t.Errorf("work = %+v", c)
			}
		case "Holidays":
			if c.Writable || c.Kind != "file" {
				t.Errorf("holidays = %+v", c)
			}
		}
	}
}

// TestCreateEventTimes checks how create_event reads the times a model writes before handing the
// event to the host.
func TestCreateEventTimes(t *testing.T) {
	inZone(t, halifaxSummer)
	s := newTestStore(t)
	w := &fakeEventWriter{}
	r := NewStoreRegistry(s, WithEventWriter(w))
	work := addCalendar(t, s, "Work", true)
	addCalendar(t, s, "Holidays", false) // read-only: never a default

	cases := []struct {
		name, args   string
		start, end   time.Time
		allDay       bool
		repeatFreq   string
		repeatUntil  string
		wantLocation bool
	}{
		{name: "timed, an hour by default", args: `"startsAt":"2026-09-20T12:00:00-03:00"`,
			start: time.Date(2026, 9, 20, 15, 0, 0, 0, time.UTC), end: time.Date(2026, 9, 20, 16, 0, 0, 0, time.UTC)},
		{name: "local time without an offset", args: `"startsAt":"2026-09-20T15:00","endsAt":"2026-09-20T15:45","location":"Café"`,
			start: time.Date(2026, 9, 20, 18, 0, 0, 0, time.UTC), end: time.Date(2026, 9, 20, 18, 45, 0, 0, time.UTC), wantLocation: true},
		{name: "all-day by date, last day inclusive", args: `"startsAt":"2026-09-20","endsAt":"2026-09-22"`,
			start: time.Date(2026, 9, 20, 0, 0, 0, 0, time.UTC), end: time.Date(2026, 9, 23, 0, 0, 0, 0, time.UTC), allDay: true},
		{name: "all-day from a midnight-UTC timestamp keeps its date", args: `"startsAt":"2026-09-20T00:00:00Z","allDay":true`,
			start: time.Date(2026, 9, 20, 0, 0, 0, 0, time.UTC), end: time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC), allDay: true},
		{name: "weekly until a date", args: `"startsAt":"2026-09-21T09:00:00-03:00","repeat":{"freq":"weekly","until":"2026-12-01"}`,
			start: time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC), end: time.Date(2026, 9, 21, 13, 0, 0, 0, time.UTC),
			repeatFreq: "weekly", repeatUntil: "2026-12-01"},
	}
	for i, tc := range cases {
		got := invokeJSON[map[string]any](t, r, "create_event", `{"title":"Focus",`+tc.args+`}`)
		if got["id"] != "new-event" || got["calendar"] != "Work" {
			t.Errorf("%s: result %+v", tc.name, got)
		}
		f := w.created[i]
		if w.createdIn[i] != work.ID {
			t.Errorf("%s: created in %s, want the only writable calendar", tc.name, w.createdIn[i])
		}
		if !f.StartsAt.Equal(tc.start) || f.EndsAt == nil || !f.EndsAt.Equal(tc.end) || f.AllDay != tc.allDay {
			t.Errorf("%s: start %v end %v allDay %v, want %v %v %v", tc.name, f.StartsAt, f.EndsAt, f.AllDay, tc.start, tc.end, tc.allDay)
		}
		if (f.Location != nil) != tc.wantLocation {
			t.Errorf("%s: location %v", tc.name, f.Location)
		}
		switch {
		case tc.repeatFreq == "" && f.Repeat != nil:
			t.Errorf("%s: unexpected repeat %+v", tc.name, f.Repeat)
		case tc.repeatFreq != "" && (f.Repeat == nil || f.Repeat.Freq != tc.repeatFreq || f.Repeat.Until == nil || f.Repeat.Until.Format(dayLayout) != tc.repeatUntil):
			t.Errorf("%s: repeat %+v", tc.name, f.Repeat)
		}
	}

	for _, bad := range []string{
		`{"title":"","startsAt":"2026-09-20T12:00:00-03:00"}`,
		`{"title":"x"}`,
		`{"title":"x","startsAt":"next tuesday"}`,
		`{"title":"x","startsAt":"2026-09-20T12:00:00-03:00","endsAt":"2026-09-20T11:00:00-03:00"}`,
		`{"title":"x","startsAt":"2026-09-22","endsAt":"2026-09-20"}`,
		`{"title":"x","startsAt":"2026-09-20T12:00:00-03:00","repeat":{"freq":"fortnightly"}}`,
	} {
		if _, err := r.Invoke(context.Background(), "create_event", json.RawMessage(bad)); err == nil {
			t.Errorf("create_event(%s) should fail", bad)
		}
	}
	if len(w.created) != len(cases) {
		t.Errorf("a rejected call reached the writer: %d creates", len(w.created))
	}
}

// TestCreateEventPicksACalendar checks the calendar choice: the one named, the only writable one,
// or — when that's ambiguous or impossible — an error that tells the model what to do.
func TestCreateEventPicksACalendar(t *testing.T) {
	s := newTestStore(t)
	w := &fakeEventWriter{}
	r := NewStoreRegistry(s, WithEventWriter(w))
	ctx := context.Background()
	holidays := addCalendar(t, s, "Holidays", false)
	args := func(extra string) json.RawMessage {
		return json.RawMessage(`{"title":"Lunch","startsAt":"2026-09-20T12:00:00Z"` + extra + `}`)
	}

	if _, err := r.Invoke(ctx, "create_event", args("")); err == nil || !strings.Contains(err.Error(), "task") {
		t.Errorf("no writable calendar: %v", err)
	}
	if _, err := r.Invoke(ctx, "create_event", args(`,"calendarId":"`+holidays.ID+`"`)); err == nil || !strings.Contains(err.Error(), "read-only") {
		t.Errorf("read-only calendar: %v", err)
	}
	work := addCalendar(t, s, "Work", true)
	home := addCalendar(t, s, "Home", true)
	if _, err := r.Invoke(ctx, "create_event", args("")); err == nil || !strings.Contains(err.Error(), "Work") || !strings.Contains(err.Error(), "Home") {
		t.Errorf("two writable calendars: %v", err)
	}
	if _, err := r.Invoke(ctx, "create_event", args(`,"calendarId":"`+home.ID+`"`)); err != nil {
		t.Fatalf("named calendar: %v", err)
	}
	if len(w.createdIn) != 1 || w.createdIn[0] != home.ID {
		t.Errorf("created in %v, want [%s] (not %s)", w.createdIn, home.ID, work.ID)
	}
}

// TestUpdateEventPatches checks update_event's arguments become the patch the calendar editor
// would send, read against the event as it is now.
func TestUpdateEventPatches(t *testing.T) {
	inZone(t, halifaxSummer)
	s := newTestStore(t)
	w := &fakeEventWriter{}
	r := NewStoreRegistry(s, WithEventWriter(w))
	work := addCalendar(t, s, "Work", true)
	late := time.Date(2026, 9, 18, 23, 30, 0, 0, halifaxSummer) // 02:30Z on the 19th
	allDayStart := time.Date(2026, 9, 18, 0, 0, 0, 0, time.UTC)
	setEvents(t, s, work,
		&domain.CalendarEvent{ICSUID: "late", Title: "Late call", StartsAt: late, EndsAt: at(late.Add(time.Hour)), Location: strPtr("Zoom")},
		&domain.CalendarEvent{ICSUID: "trip", Title: "Trip", StartsAt: allDayStart, EndsAt: at(allDayStart.AddDate(0, 0, 1)), AllDay: true},
	)
	lateID := calendar.EventID(work.ID, "late", late)
	tripID := calendar.EventID(work.ID, "trip", allDayStart)

	update := func(args string) calendar.EventPatch {
		t.Helper()
		if _, err := r.Invoke(context.Background(), "update_event", json.RawMessage(args)); err != nil {
			t.Fatalf("update_event(%s): %v", args, err)
		}
		return w.patches[len(w.patches)-1]
	}

	// Moving a timed event keeps its length (no EndsAt).
	p := update(`{"id":"` + lateID + `","startsAt":"2026-09-18T14:00:00-03:00"}`)
	if p.StartsAt == nil || !p.StartsAt.Equal(time.Date(2026, 9, 18, 17, 0, 0, 0, time.UTC)) || p.EndsAt != nil || p.AllDay != nil {
		t.Errorf("move: %+v", p)
	}
	// Turning it all-day keeps the day the user sees it on (the 18th), not its UTC date (the 19th).
	p = update(`{"id":"` + lateID + `","allDay":true}`)
	if p.AllDay == nil || !*p.AllDay || p.StartsAt == nil || !p.StartsAt.Equal(allDayStart) {
		t.Errorf("to all-day: %+v", p)
	}
	// "" clears a field; an omitted one is untouched.
	p = update(`{"id":"` + lateID + `","location":"","title":" Late sync "}`)
	if p.Location == nil || *p.Location != "" || p.Description != nil || p.Title == nil || *p.Title != "Late sync" {
		t.Errorf("clear location / retitle: %+v", p)
	}
	p = update(`{"id":"` + lateID + `","repeat":{"freq":"none"}}`)
	if p.Repeat == nil || p.Repeat.Freq != calendar.RepeatNone {
		t.Errorf("stop repeating: %+v", p)
	}
	// An all-day event's end is its last day.
	p = update(`{"id":"` + tripID + `","endsAt":"2026-09-20"}`)
	if p.EndsAt == nil || !p.EndsAt.Equal(time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC)) || p.StartsAt != nil {
		t.Errorf("extend trip: %+v", p)
	}
	// Timed from all-day needs a start, and gets an hour when no end is given.
	if _, err := r.Invoke(context.Background(), "update_event", json.RawMessage(`{"id":"`+tripID+`","allDay":false}`)); err == nil {
		t.Error("all-day to timed without a start should fail")
	}
	p = update(`{"id":"` + tripID + `","allDay":false,"startsAt":"2026-09-18T10:00:00-03:00"}`)
	if p.AllDay == nil || *p.AllDay || p.EndsAt == nil || p.EndsAt.Sub(*p.StartsAt) != time.Hour {
		t.Errorf("to timed: %+v", p)
	}
	if w.updated[0] != lateID {
		t.Errorf("updated %s, want %s", w.updated[0], lateID)
	}

	for _, bad := range []string{`{"id":"` + lateID + `"}`, `{"id":"nope","title":"x"}`, `{"id":"` + lateID + `","title":"  "}`} {
		if _, err := r.Invoke(context.Background(), "update_event", json.RawMessage(bad)); err == nil {
			t.Errorf("update_event(%s) should fail", bad)
		}
	}
}

// TestCalendarWriteToolsAreWrites keeps event writes behind an agent's write permission.
func TestCalendarWriteToolsAreWrites(t *testing.T) {
	r := NewStoreRegistry(newTestStore(t), WithEventWriter(&fakeEventWriter{}))
	for _, name := range []string{"create_event", "update_event"} {
		if !r.IsWrite(name) {
			t.Errorf("%s is not a write tool", name)
		}
	}
	for _, name := range []string{"list_calendars", "list_events", "get_event", "render_event"} {
		if r.IsWrite(name) {
			t.Errorf("%s should be read-only", name)
		}
	}
	ro := r.ReadOnly()
	if _, err := ro.Invoke(context.Background(), "create_event", json.RawMessage(`{}`)); err == nil {
		t.Error("a read-only registry still offers create_event")
	}
}

func strPtr(s string) *string { return &s }
