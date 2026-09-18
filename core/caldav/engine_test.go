package caldav_test

import (
	"strings"
	"testing"
	"time"

	"companion/core/caldav"
	"companion/core/caldav/caldavtest"
	"companion/core/calendar"
	"companion/core/domain"
	"companion/core/store"
)

// device is one Companion install: its own store, talking to the shared fake provider.
type device struct {
	t      *testing.T
	st     *store.Store
	engine *caldav.Engine
	client *caldav.Client
	feed   *domain.CalendarFeed
}

func eventICS(uid, title string, start time.Time) string {
	end := start.Add(time.Hour)
	ics, err := calendar.NewObject(uid, calendar.EventFields{Title: title, StartsAt: start, EndsAt: &end}, time.Now())
	if err != nil {
		panic(err)
	}
	return ics
}

func soon(h int) time.Time {
	return time.Now().UTC().Truncate(time.Hour).Add(time.Duration(h) * time.Hour)
}

func newDevice(t *testing.T, s *caldavtest.Server) *device {
	t.Helper()
	st, err := store.Open(":memory:", domain.SystemClock{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	c, err := caldav.New(s.URL, s.Username, s.Password, nil)
	if err != nil {
		t.Fatal(err)
	}
	acct, err := st.CalendarAccounts.Create(store.CreateAccountInput{Name: "Test", ServerURL: s.URL, Username: s.Username})
	if err != nil {
		t.Fatal(err)
	}
	d := &device{t: t, st: st, engine: &caldav.Engine{Store: st}, client: c}
	feeds, err := d.engine.SyncCalendars(ctx, c, acct)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range feeds {
		if f.Name == "Work" {
			d.feed = f
		}
	}
	if d.feed == nil {
		t.Fatalf("Work calendar not discovered: %+v", feeds)
	}
	return d
}

func (d *device) sync() caldav.Result {
	d.t.Helper()
	res, err := d.engine.SyncFeed(ctx, d.client, d.feed)
	if err != nil {
		d.t.Fatal(err)
	}
	return res
}

func (d *device) titles() []string {
	d.t.Helper()
	items, err := d.st.CalendarEvents.Range(time.Now().AddDate(0, -1, 0), time.Now().AddDate(0, 1, 0))
	if err != nil {
		d.t.Fatal(err)
	}
	var out []string
	for _, it := range items {
		if it.Kind == domain.ItemEvent {
			out = append(out, it.Title)
		}
	}
	return out
}

// edit applies a local change to an object the way the bridge does.
func (d *device) edit(uid string, state domain.PushState, mutate func(ics string) string) {
	d.t.Helper()
	o, err := d.st.CalendarObjects.Get(calendar.ObjectID(d.feed.ID, uid))
	if err != nil {
		d.t.Fatal(err)
	}
	o.ICS = mutate(o.ICS)
	if !o.PushState.Pending() || state == domain.PushPendingDelete {
		o.PushState = state
	}
	if err := d.st.CalendarObjects.Put(o); err != nil {
		d.t.Fatal(err)
	}
	if _, err := d.st.CalendarEvents.DeriveFromObject(o); err != nil {
		d.t.Fatal(err)
	}
}

func rename(title string) func(string) string {
	return func(ics string) string {
		out, err := calendar.ApplyEdit(ics, calendar.EventPatch{Title: &title}, time.Now())
		if err != nil {
			panic(err)
		}
		return out
	}
}

func keep(ics string) string { return ics }

func TestSyncCalendarsIsIdempotentAndTracksPrivileges(t *testing.T) {
	s := caldavtest.New("sam", "pw")
	defer s.Close()
	s.AddCalendar("work", "Work", "#112233", false)
	s.AddCalendar("holidays", "Holidays", "", true)
	d := newDevice(t, s)

	acct, _ := d.st.CalendarAccounts.List()
	again, err := d.engine.SyncCalendars(ctx, d.client, acct[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(again) != 2 {
		t.Fatalf("rescan must not duplicate calendars: %+v", again)
	}
	for _, f := range again {
		if !f.IsCalDAV() || f.AccountID == nil || *f.AccountID != acct[0].ID {
			t.Errorf("feed not linked to its account: %+v", f)
		}
		if f.Name == "Holidays" && f.Writable() {
			t.Errorf("read-only calendar reported writable")
		}
		if f.Name == "Work" && (!f.Writable() || f.Color == nil || *f.Color != "#112233") {
			t.Errorf("work calendar: %+v", f)
		}
	}
	if fresh, _ := d.st.CalendarAccounts.Get(acct[0].ID); fresh.HomeSetURL == "" {
		t.Errorf("home set should be remembered so a rescan skips discovery")
	}
}

func TestPullCreatesUpdatesAndDeletes(t *testing.T) {
	s := caldavtest.New("sam", "pw")
	defer s.Close()
	cal := s.AddCalendar("work", "Work", "", false)
	href := s.PutObject(cal, "a.ics", eventICS("a", "Planning", soon(24)))
	d := newDevice(t, s)

	if res := d.sync(); res.Pulled != 1 {
		t.Fatalf("first pull: %+v", res)
	}
	if got := d.titles(); len(got) != 1 || got[0] != "Planning" {
		t.Fatalf("after pull: %v", got)
	}

	// A quiet calendar costs one ctag PROPFIND and nothing else.
	reports := s.Count("REPORT")
	if res := d.sync(); res.Pulled != 0 || s.Count("REPORT") != reports {
		t.Errorf("unchanged ctag should skip the listing: %+v (reports %d→%d)", res, reports, s.Count("REPORT"))
	}

	s.PutObject(cal, "a.ics", eventICS("a", "Planning v2", soon(24)))
	d.sync()
	if got := d.titles(); len(got) != 1 || got[0] != "Planning v2" {
		t.Fatalf("after remote edit: %v", got)
	}

	s.RemoveObject(href)
	d.sync()
	if got := d.titles(); len(got) != 0 {
		t.Fatalf("after remote delete: %v", got)
	}
	if _, err := d.st.CalendarObjects.Get(calendar.ObjectID(d.feed.ID, "a")); err != store.ErrNotFound {
		t.Errorf("object should be tombstoned, got %v", err)
	}
}

func TestPushCreateUpdateDelete(t *testing.T) {
	s := caldavtest.New("sam", "pw")
	defer s.Close()
	cal := s.AddCalendar("work", "Work", "", false)
	d := newDevice(t, s)

	// Create locally.
	o := &domain.CalendarObject{
		ID: calendar.ObjectID(d.feed.ID, "NEW-1"), FeedID: d.feed.ID, UID: "NEW-1",
		ICS: eventICS("NEW-1", "Coffee", soon(5)), PushState: domain.PushPendingCreate,
	}
	if err := d.st.CalendarObjects.Put(o); err != nil {
		t.Fatal(err)
	}
	d.st.CalendarEvents.DeriveFromObject(o)
	if res := d.sync(); res.Pushed != 1 || len(res.Conflicts) != 0 {
		t.Fatalf("push create: %+v", res)
	}
	href := caldav.ObjectURL(cal, "NEW-1")
	if !strings.Contains(s.Object(href), "SUMMARY:Coffee") {
		t.Fatalf("provider did not receive the event: %q", s.Object(href))
	}
	got, _ := d.st.CalendarObjects.Get(o.ID)
	if got.PushState != domain.PushSynced || got.ETag == "" || got.Href != href {
		t.Fatalf("object after push: %+v", got)
	}

	// Update.
	d.edit("NEW-1", domain.PushPendingUpdate, rename("Coffee with Sam"))
	d.sync()
	if !strings.Contains(s.Object(href), "SUMMARY:Coffee with Sam") {
		t.Fatalf("provider did not receive the update: %q", s.Object(href))
	}

	// Delete: gone from the calendar at once, gone from the provider after the push.
	d.edit("NEW-1", domain.PushPendingDelete, keep)
	if got := d.titles(); len(got) != 0 {
		t.Fatalf("a pending delete must hide the event immediately: %v", got)
	}
	d.sync()
	if s.Object(href) != "" {
		t.Fatalf("provider still has the event")
	}
}

func TestStaleEditLosesToProviderAndIsReported(t *testing.T) {
	s := caldavtest.New("sam", "pw")
	defer s.Close()
	cal := s.AddCalendar("work", "Work", "", false)
	s.PutObject(cal, "a.ics", eventICS("a", "Review", soon(24)))
	d := newDevice(t, s)
	d.sync()

	// The event changes on the phone's native calendar app while we edit it here.
	s.PutObject(cal, "a.ics", eventICS("a", "Review (moved by Sam)", soon(30)))
	d.edit("a", domain.PushPendingUpdate, rename("Review — my title"))

	res := d.sync()
	if len(res.Conflicts) != 1 || res.Conflicts[0].Title != "Review — my title" {
		t.Fatalf("want one reported conflict, got %+v", res)
	}
	if got := d.titles(); len(got) != 1 || got[0] != "Review (moved by Sam)" {
		t.Fatalf("provider copy should win: %v", got)
	}
	if !strings.Contains(s.Object(cal+"a.ics"), "moved by Sam") {
		t.Fatalf("the provider's event must never be clobbered by a stale write")
	}
}

func TestTwoDevicesPushingTheSamePendingRowIsNotAConflict(t *testing.T) {
	s := caldavtest.New("sam", "pw")
	defer s.Close()
	s.AddCalendar("work", "Work", "", false)
	a, b := newDevice(t, s), newDevice(t, s)

	// The same pending create reaches both native devices through Companion sync (simulated by
	// writing the identical row into each store; feed ids differ per store here, the UID does not).
	ics := eventICS("SHARED-1", "Standup", soon(3))
	for _, d := range []*device{a, b} {
		o := &domain.CalendarObject{ID: calendar.ObjectID(d.feed.ID, "SHARED-1"), FeedID: d.feed.ID, UID: "SHARED-1", ICS: ics, PushState: domain.PushPendingCreate}
		if err := d.st.CalendarObjects.Put(o); err != nil {
			t.Fatal(err)
		}
	}
	if res := a.sync(); res.Pushed != 1 {
		t.Fatalf("device A: %+v", res)
	}
	res := b.sync()
	if len(res.Conflicts) != 0 {
		t.Fatalf("losing the race with identical content is not a conflict: %+v", res)
	}
	got, _ := b.st.CalendarObjects.Get(calendar.ObjectID(b.feed.ID, "SHARED-1"))
	if got.PushState != domain.PushSynced || got.ETag == "" {
		t.Fatalf("device B should settle on the provider's version: %+v", got)
	}
	if n := len(s.Objects(b.feed.URL)); n != 1 {
		t.Fatalf("want exactly one event on the provider, got %d", n)
	}
}

func TestPullNeverOverwritesAPendingLocalChange(t *testing.T) {
	s := caldavtest.New("sam", "pw")
	defer s.Close()
	cal := s.AddCalendar("work", "Work", "", false)
	s.PutObject(cal, "a.ics", eventICS("a", "Draft", soon(24)))
	s.PutObject(cal, "b.ics", eventICS("b", "Other", soon(26)))
	d := newDevice(t, s)
	d.sync()

	d.edit("a", domain.PushPendingUpdate, rename("Final"))
	// An unrelated remote change moves the ctag, forcing a full listing on the next sync.
	s.PutObject(cal, "b.ics", eventICS("b", "Other v2", soon(26)))
	d.sync()

	if !strings.Contains(s.Object(cal+"a.ics"), "SUMMARY:Final") {
		t.Fatalf("local edit should have been pushed, provider has: %q", s.Object(cal+"a.ics"))
	}
	got := d.titles()
	if len(got) != 2 || !(contains(got, "Final") && contains(got, "Other v2")) {
		t.Fatalf("want [Final, Other v2], got %v", got)
	}
}

func TestReadOnlyCalendarFailureIsRecordedNotFatal(t *testing.T) {
	s := caldavtest.New("sam", "pw")
	defer s.Close()
	s.AddCalendar("work", "Work", "", true) // server refuses writes with 403
	d := newDevice(t, s)
	o := &domain.CalendarObject{ID: calendar.ObjectID(d.feed.ID, "X"), FeedID: d.feed.ID, UID: "X", ICS: eventICS("X", "Nope", soon(2)), PushState: domain.PushPendingCreate}
	d.st.CalendarObjects.Put(o)

	d.sync() // must not error out
	got, _ := d.st.CalendarObjects.Get(o.ID)
	if got.PushState != domain.PushPendingCreate || got.PushError == nil {
		t.Fatalf("a refused push stays pending with its reason: %+v", got)
	}
	version := got.UpdatedAt
	d.sync()
	if again, _ := d.st.CalendarObjects.Get(o.ID); !again.UpdatedAt.Equal(version) {
		t.Errorf("an unchanged error must not rewrite (and re-sync) the row")
	}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// The state a real database got into: every calendar orphaned from its account (kind "ics", no
// account id) and then re-created by each rescan, so three copies of each, two of them holding
// the same events. A rescan must put it right: one feed per calendar, re-attached, no doubled
// events, and nothing re-downloaded that was already here.
func TestRescanAdoptsOrphansAndCollapsesDuplicates(t *testing.T) {
	s := caldavtest.New("sam", "pw")
	defer s.Close()
	cal := s.AddCalendar("work", "Work", "", false)
	s.PutObject(cal, "a.ics", eventICS("a", "Planning", soon(24)))
	d := newDevice(t, s)
	d.sync()
	acct, _ := d.st.CalendarAccounts.List()
	original := d.feed.ID

	orphan := func() {
		t.Helper()
		feeds, _ := d.st.CalendarFeeds.List()
		for _, f := range feeds {
			stripped := *f
			stripped.Kind, stripped.AccountID = domain.FeedKindICS, nil // what an old server's echo did
			if err := d.st.CalendarFeeds.Apply(&stripped); err != nil {
				t.Fatal(err)
			}
		}
	}
	// Reproduce the damage with the old matching rule's outcome: orphan, then a second copy that
	// also pulled the events, then orphan again.
	orphan()
	dup, err := d.st.CalendarFeeds.Create(store.CreateFeedInput{Name: "Work", URL: cal, Kind: domain.FeedKindCalDAV, AccountID: &acct[0].ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.engine.SyncFeed(ctx, d.client, dup); err != nil {
		t.Fatal(err)
	}
	orphan()
	if got := d.titles(); len(got) != 2 {
		t.Fatalf("setup: want the doubled event, got %v", got)
	}
	if attached, _ := d.st.CalendarFeeds.ListByAccount(acct[0].ID); len(attached) != 0 {
		t.Fatalf("setup: feeds should be orphaned, got %d attached", len(attached))
	}

	feeds, err := d.engine.SyncCalendars(ctx, d.client, acct[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(feeds) != 1 || feeds[0].ID != original || !feeds[0].IsCalDAV() {
		t.Fatalf("want the original feed re-attached and nothing else, got %+v", feeds)
	}
	if all, _ := d.st.CalendarFeeds.List(); len(all) != 1 {
		t.Fatalf("duplicates should be gone, have %d feeds", len(all))
	}
	if got := d.titles(); len(got) != 1 || got[0] != "Planning" {
		t.Fatalf("doubled events should be gone: %v", got)
	}
	// Idempotent.
	if again, _ := d.engine.SyncCalendars(ctx, d.client, acct[0]); len(again) != 1 {
		t.Fatalf("a second rescan changed things: %+v", again)
	}
}

// A project that held a copy the rescan collapses keeps the calendar: its membership moves to
// the copy that survives (PLAN §6.6), and the project's calendar still shows the events once.
func TestRescanKeepsACollapsedCopyInItsProjects(t *testing.T) {
	s := caldavtest.New("sam", "pw")
	defer s.Close()
	cal := s.AddCalendar("work", "Work", "", false)
	s.PutObject(cal, "a.ics", eventICS("a", "Planning", soon(24)))
	d := newDevice(t, s)
	d.sync()
	acct, _ := d.st.CalendarAccounts.List()

	// A second copy of the same calendar, filed in a project; the rescan keeps the original.
	dup, err := d.st.CalendarFeeds.Create(store.CreateFeedInput{Name: "Work", URL: cal, Kind: domain.FeedKindCalDAV, AccountID: &acct[0].ID})
	if err != nil {
		t.Fatal(err)
	}
	const project = "project-1"
	if _, err := d.st.ProjectMembers.Add(project, domain.MemberCalendar, dup.ID); err != nil {
		t.Fatal(err)
	}

	if _, err := d.engine.SyncCalendars(ctx, d.client, acct[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := d.st.CalendarFeeds.Get(dup.ID); err == nil {
		t.Fatalf("setup: the rescan should have dropped the duplicate")
	}
	members, _ := d.st.ProjectMembers.ListForProject(project)
	if len(members) != 1 || members[0].EntityID != d.feed.ID {
		t.Fatalf("the project should hold the surviving copy, got %+v", members)
	}
	items, err := d.st.CalendarEvents.RangeForProject(time.Now().AddDate(0, -1, 0), time.Now().AddDate(0, 1, 0), project)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Title != "Planning" {
		t.Fatalf("the project's calendar should show the event once, got %+v", items)
	}
}
