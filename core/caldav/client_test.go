package caldav_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"companion/core/caldav"
	"companion/core/caldav/caldavtest"
)

const sampleICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//T//EN\r\nBEGIN:VEVENT\r\nUID:one\r\n" +
	"DTSTAMP:20260901T100000Z\r\nDTSTART:20260920T140000Z\r\nSUMMARY:One\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"

var ctx = context.Background()

func newClient(t *testing.T, s *caldavtest.Server) *caldav.Client {
	t.Helper()
	c, err := caldav.New(s.URL, s.Username, s.Password, nil)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestDiscoverAndListCalendars(t *testing.T) {
	s := caldavtest.New("sam", "app-pass")
	defer s.Close()
	work := s.AddCalendar("work", "Work & Co", "#FF2968FF", false)
	s.AddCalendar("holidays", "Holidays", "", true)
	s.AddTaskList("reminders", "Reminders")

	c := newClient(t, s)
	home, err := c.Discover(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cals, err := c.Calendars(ctx, home)
	if err != nil {
		t.Fatal(err)
	}
	if len(cals) != 2 {
		t.Fatalf("want 2 event calendars (task list skipped), got %+v", cals)
	}
	var gotWork, gotHolidays bool
	for _, cal := range cals {
		switch cal.Name {
		case "Work & Co":
			gotWork = cal.URL == work && cal.Color == "#FF2968" && !cal.ReadOnly && cal.CTag != ""
		case "Holidays":
			gotHolidays = cal.ReadOnly && cal.Color == ""
		}
	}
	if !gotWork || !gotHolidays {
		t.Errorf("calendar properties wrong: %+v", cals)
	}
}

func TestWrongPasswordIsUnauthorized(t *testing.T) {
	s := caldavtest.New("sam", "right")
	defer s.Close()
	c, _ := caldav.New(s.URL, "sam", "wrong", nil)
	if _, err := c.Discover(ctx); !errors.Is(err, caldav.ErrUnauthorized) {
		t.Fatalf("want ErrUnauthorized, got %v", err)
	}
}

func TestConditionalWrites(t *testing.T) {
	s := caldavtest.New("sam", "pw")
	defer s.Close()
	cal := s.AddCalendar("work", "Work", "", false)
	c := newClient(t, s)
	href := caldav.ObjectURL(cal, "one")

	etag, err := c.Create(ctx, href, sampleICS)
	if err != nil || etag == "" {
		t.Fatalf("create: %q %v", etag, err)
	}
	// A second create of the same UID must not overwrite.
	if _, err := c.Create(ctx, href, sampleICS); !errors.Is(err, caldav.ErrPreconditionFailed) {
		t.Fatalf("second create: want 412, got %v", err)
	}
	// Someone else edits it; our stale etag must be refused.
	s.PutObject(cal, "one.ics", sampleICS+" ")
	if _, err := c.Update(ctx, href, sampleICS, etag); !errors.Is(err, caldav.ErrPreconditionFailed) {
		t.Fatalf("stale update: want 412, got %v", err)
	}
	if err := c.Delete(ctx, href, etag); !errors.Is(err, caldav.ErrPreconditionFailed) {
		t.Fatalf("stale delete: want 412, got %v", err)
	}
	// With the current etag both succeed.
	cur, err := c.Get(ctx, href)
	if err != nil {
		t.Fatal(err)
	}
	etag2, err := c.Update(ctx, href, sampleICS, cur.ETag)
	if err != nil || etag2 == cur.ETag {
		t.Fatalf("update: %q %v", etag2, err)
	}
	if err := c.Delete(ctx, href, etag2); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Get(ctx, href); !errors.Is(err, caldav.ErrNotFound) {
		t.Fatalf("get after delete: want ErrNotFound, got %v", err)
	}
}

func TestListAndMultiGet(t *testing.T) {
	s := caldavtest.New("sam", "pw")
	defer s.Close()
	cal := s.AddCalendar("work", "Work", "", false)
	a := s.PutObject(cal, "a.ics", sampleICS)
	s.PutObject(cal, "b b.ics", sampleICS) // a space in the name must survive the href round trip
	c := newClient(t, s)

	now := time.Now()
	entries, err := c.ListETags(ctx, cal, now.AddDate(-1, 0, 0), now.AddDate(1, 0, 0))
	if err != nil || len(entries) != 2 {
		t.Fatalf("list: %+v %v", entries, err)
	}
	hrefs := []string{entries[0].Href, entries[1].Href}
	objs, err := c.MultiGet(ctx, cal, hrefs)
	if err != nil || len(objs) != 2 {
		t.Fatalf("multiget: %+v %v", objs, err)
	}
	if objs[0].Href != a || objs[0].ICS != sampleICS || objs[0].ETag != entries[0].ETag {
		t.Errorf("multiget object mismatch: %+v vs %+v", objs[0], entries[0])
	}
}

func TestCredentialsNeverFollowARedirectOffSite(t *testing.T) {
	var leaked bool
	evil := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, _, ok := r.BasicAuth(); ok {
			leaked = true
		}
	}))
	defer evil.Close()
	// 127.0.0.1 → "localhost" is a different host, so this is an off-site hop.
	target := "http://localhost" + evil.URL[len("http://127.0.0.1"):]
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target, http.StatusMovedPermanently)
	}))
	defer front.Close()

	c, _ := caldav.New(front.URL, "sam", "pw", nil)
	if _, err := c.Discover(ctx); err == nil {
		t.Fatal("expected discovery to fail")
	}
	if leaked {
		t.Fatal("credentials were sent to a host the user never named")
	}
}

func TestServerURLTransportRule(t *testing.T) {
	for raw, ok := range map[string]bool{
		"caldav.icloud.com":        true, // scheme defaults to https
		"https://example.com/dav":  true,
		"http://example.com":       false, // password would cross the internet in the clear
		"http://192.168.1.10:5232": true,  // Radicale on the LAN
		"http://nas.local/caldav":  true,
		"ftp://example.com":        false,
		"":                         false,
	} {
		if _, err := caldav.ParseServerURL(raw); (err == nil) != ok {
			t.Errorf("ParseServerURL(%q): ok=%v, err=%v", raw, ok, err)
		}
	}
}
