package syncserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"companion/core/store"
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

// TestParseAndExpand exercises ICS parsing + RRULE expansion offline (no server, no
// network): one single occurrence plus three weekly ones, with stable deterministic ids.
func TestParseAndExpand(t *testing.T) {
	now := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	events, err := parseAndExpand(strings.NewReader(fixtureICS), "feed-1", now)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(events) != 4 {
		t.Fatalf("expected 4 occurrences (1 single + 3 weekly), got %d", len(events))
	}

	// The single event carries its title, end, and location.
	byTitle := map[string]int{}
	for _, e := range events {
		byTitle[e.Title]++
		if e.Title == "Kickoff" {
			if e.EndsAt == nil || e.Location == nil || *e.Location != "Room 1" {
				t.Errorf("single event missing end/location: %+v", e)
			}
		}
	}
	if byTitle["Kickoff"] != 1 || byTitle["Standup"] != 3 {
		t.Fatalf("unexpected title counts: %v", byTitle)
	}

	// Ids are deterministic across parses (idempotent upserts depend on this).
	again, _ := parseAndExpand(strings.NewReader(fixtureICS), "feed-1", now)
	ids := map[string]bool{}
	for _, e := range events {
		ids[e.ID] = true
	}
	for _, e := range again {
		if !ids[e.ID] {
			t.Fatalf("event id not stable across parses: %s", e.ID)
		}
	}
}

// TestNormalizeFeedURL covers the webcal(s):// → https:// rewrite Google/Outlook links need.
func TestNormalizeFeedURL(t *testing.T) {
	cases := map[string]string{
		"webcal://example.com/a.ics":   "https://example.com/a.ics",
		"WEBCAL://example.com/a.ics":   "https://example.com/a.ics",
		"webcals://example.com/a.ics":  "https://example.com/a.ics",
		"https://example.com/a.ics":    "https://example.com/a.ics",
		"  http://example.com/a.ics  ": "http://example.com/a.ics",
	}
	for in, want := range cases {
		if got := normalizeFeedURL(in); got != want {
			t.Errorf("normalizeFeedURL(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestExpandHonorsExdate verifies a deleted instance of a recurring event (EXDATE) is not
// cloned — the common Google case of removing one occurrence from a series.
func TestExpandHonorsExdate(t *testing.T) {
	const ics = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:series-1
SUMMARY:Weekly
DTSTART:20260706T110000Z
DTEND:20260706T113000Z
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4
EXDATE:20260713T110000Z
END:VEVENT
END:VCALENDAR`
	now := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	events, err := parseAndExpand(strings.NewReader(ics), "f1", now)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	// 4 in the series minus the 1 excluded = 3.
	if len(events) != 3 {
		t.Fatalf("expected 3 occurrences after EXDATE, got %d", len(events))
	}
	for _, e := range events {
		if e.StartsAt.Equal(time.Date(2026, 7, 13, 11, 0, 0, 0, time.UTC)) {
			t.Fatalf("excluded instance 2026-07-13 should not appear")
		}
	}
}

// serveICS returns a local server that serves the fixture ICS.
func serveICS(t *testing.T) *httptest.Server {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/calendar")
		w.Write([]byte(fixtureICS))
	}))
	t.Cleanup(s.Close)
	return s
}

// TestCalendarFetchReconcile drives the fetcher deterministically over a directly-inserted
// feed (no push trigger involved): first fetch clones 4 events, a re-fetch of the unchanged
// feed writes nothing (idempotent, no sync churn), and deleting the feed tombstones them.
func TestCalendarFetchReconcile(t *testing.T) {
	ics := serveICS(t)
	_, srv := newServerAPI(t)
	srv.clock = &testClock{t: time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)}

	now := "2026-07-01T00:00:00Z"
	if _, err := srv.exec(
		`INSERT INTO calendar_feeds (id, user_id, name, url, color, created_at, updated_at, version, server_seq)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
		"f1", "u1", "Team", ics.URL, nil, now, now, 1, 1); err != nil {
		t.Fatalf("insert feed: %v", err)
	}

	n, err := srv.FetchAllFeeds(context.Background())
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if n != 4 {
		t.Fatalf("expected 4 events written, got %d", n)
	}
	if got := countEvents(t, srv, "f1"); got != 4 {
		t.Fatalf("expected 4 live events, got %d", got)
	}

	// Re-fetching an unchanged feed writes nothing.
	if n2, err := srv.FetchAllFeeds(context.Background()); err != nil || n2 != 0 {
		t.Fatalf("expected idempotent re-fetch (0 writes), got %d (err %v)", n2, err)
	}

	// Deleting the feed tombstones its events.
	if _, err := srv.exec(`UPDATE calendar_feeds SET deleted_at = ? WHERE id = ?;`, now, "f1"); err != nil {
		t.Fatalf("delete feed: %v", err)
	}
	if written, _, err := srv.tombstoneFeedEvents("u1", "f1"); err != nil || written != 4 {
		t.Fatalf("expected 4 tombstoned, got %d (err %v)", written, err)
	}
	if got := countEvents(t, srv, "f1"); got != 0 {
		t.Fatalf("expected 0 live events after delete, got %d", got)
	}
}

// TestCalendarUploadedFeed proves an uploaded .ics feed (ics_text set, no URL) is parsed in
// place — the fetcher clones its events with no HTTP fetch at all.
func TestCalendarUploadedFeed(t *testing.T) {
	_, srv := newServerAPI(t)
	srv.clock = &testClock{t: time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)}

	now := "2026-07-01T00:00:00Z"
	if _, err := srv.exec(
		`INSERT INTO calendar_feeds (id, user_id, name, url, ics_text, color, created_at, updated_at, version, server_seq)
		 VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?);`,
		"f1", "u1", "Uploaded", fixtureICS, nil, now, now, 1, 1); err != nil {
		t.Fatalf("insert uploaded feed: %v", err)
	}

	if n, err := srv.FetchAllFeeds(context.Background()); err != nil || n != 4 {
		t.Fatalf("expected 4 events from uploaded ics, got %d (err %v)", n, err)
	}
	if got := countEvents(t, srv, "f1"); got != 4 {
		t.Fatalf("expected 4 live events, got %d", got)
	}
	// Re-parsing the same uploaded text is idempotent.
	if n2, err := srv.FetchAllFeeds(context.Background()); err != nil || n2 != 0 {
		t.Fatalf("expected idempotent re-parse (0), got %d (err %v)", n2, err)
	}
}

func countEvents(t *testing.T, srv *Server, feedID string) int {
	t.Helper()
	var n int
	if err := srv.queryRow(`SELECT COUNT(*) FROM calendar_events WHERE feed_id = ? AND deleted_at IS NULL;`, feedID).Scan(&n); err != nil {
		t.Fatalf("count events: %v", err)
	}
	return n
}

// TestCalendarFeedAndEventSync is the end-to-end path: a client authors a feed (which syncs
// up), the server fetches its ICS and clones the expanded events, and the client pulls them
// read-only and sees them in the merged Range. The feed also reaches a second device.
func TestCalendarFeedAndEventSync(t *testing.T) {
	ics := serveICS(t)
	ts, srv := newServerAPI(t)
	// Pin the server clock inside the fixture's ±1y window so expansion is deterministic
	// regardless of the wall clock the test runs under.
	srv.clock = &testClock{t: time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)}

	token := register(t, ts.URL, "cal@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	// Author a feed pointing at the fixture and push it up.
	feed, err := a.store.CalendarFeeds.Create(store.CreateFeedInput{Name: "Team", URL: ics.URL})
	if err != nil {
		t.Fatalf("create feed: %v", err)
	}
	if err := a.engine.Sync(); err != nil {
		t.Fatalf("push feed: %v", err)
	}

	// The server clones the feed's events. FetchAllFeeds is synchronous, so once it returns
	// all 4 events exist regardless of whether the on-push trigger already produced them.
	if _, err := srv.FetchAllFeeds(context.Background()); err != nil {
		t.Fatalf("fetch: %v", err)
	}

	// Client A pulls the read-only clones and sees them in the merged Range.
	if err := a.engine.Sync(); err != nil {
		t.Fatalf("pull events: %v", err)
	}
	from := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	items, err := a.store.CalendarEvents.Range(from, to)
	if err != nil {
		t.Fatalf("range: %v", err)
	}
	if len(items) != 4 {
		t.Fatalf("expected 4 merged items, got %d: %+v", len(items), items)
	}
	for _, it := range items {
		if string(it.Kind) != "event" {
			t.Fatalf("expected event items, got %s", it.Kind)
		}
	}
	// The clones must be clean and non-dirty (pull-only): nothing to push back.
	if dirty, _ := a.store.CalendarEvents.Dirty(); len(dirty) != 0 {
		t.Fatalf("events must never be dirty on the client, got %d", len(dirty))
	}

	// The feed (user data) reaches device B, clean and synced.
	if err := b.engine.Sync(); err != nil {
		t.Fatalf("device B sync: %v", err)
	}
	gotB, err := b.store.CalendarFeeds.GetAny(feed.ID)
	if err != nil || gotB.Dirty || gotB.Version == 0 || gotB.URL != ics.URL {
		t.Fatalf("device B feed = %+v (err %v), want clean synced copy", gotB, err)
	}
}
