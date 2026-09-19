//go:build !js

package store

import (
	"sort"
	"testing"
	"time"

	"companion/core/domain"
)

// projectCalendarFixture is a store holding one project and every kind of calendar a project can
// be given: a subscription filed directly, one left out, and an account filed whole.
type projectCalendarFixture struct {
	s                        *Store
	clk                      *fixedClock
	project                  *domain.Project
	filed, unfiled           *domain.CalendarFeed
	account                  *domain.CalendarAccount
	accountCal1, accountCal2 *domain.CalendarFeed
	dayStart, dayEnd         time.Time
}

func newProjectCalendarFixture(t *testing.T) *projectCalendarFixture {
	t.Helper()
	clk := &fixedClock{t: time.Date(2026, 7, 4, 8, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)
	f := &projectCalendarFixture{s: s, clk: clk,
		dayStart: time.Date(2026, 7, 4, 0, 0, 0, 0, time.UTC),
		dayEnd:   time.Date(2026, 7, 5, 0, 0, 0, 0, time.UTC),
	}
	var err error
	area, err := s.Areas.Create(CreateAreaInput{Name: "Work"})
	if err != nil {
		t.Fatal(err)
	}
	if f.project, err = s.Projects.Create(CreateProjectInput{AreaID: area.ID, Name: "Launch"}); err != nil {
		t.Fatal(err)
	}
	if f.filed, err = s.CalendarFeeds.Create(CreateFeedInput{Name: "Fixtures", URL: "https://example.com/fixtures.ics"}); err != nil {
		t.Fatal(err)
	}
	if f.unfiled, err = s.CalendarFeeds.Create(CreateFeedInput{Name: "Holidays", URL: "https://example.com/holidays.ics"}); err != nil {
		t.Fatal(err)
	}
	if f.account, err = s.CalendarAccounts.Create(CreateAccountInput{Name: "iCloud", ServerURL: "https://caldav.example.com", Username: "sam"}); err != nil {
		t.Fatal(err)
	}
	for i, name := range []string{"Home", "Work"} {
		cal, err := s.CalendarFeeds.Create(CreateFeedInput{
			Name: name, URL: "https://caldav.example.com/" + name + "/", Kind: domain.FeedKindCalDAV, AccountID: &f.account.ID,
		})
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			f.accountCal1 = cal
		} else {
			f.accountCal2 = cal
		}
	}
	// One 09:00 event in every calendar.
	for _, feed := range []*domain.CalendarFeed{f.filed, f.unfiled, f.accountCal1, f.accountCal2} {
		start := time.Date(2026, 7, 4, 9, 0, 0, 0, time.UTC)
		end := start.Add(time.Hour)
		if err := s.CalendarEvents.Apply(&domain.CalendarEvent{
			ID: "ev-" + feed.Name, FeedID: feed.ID, ICSUID: "u-" + feed.Name, Title: feed.Name,
			StartsAt: start, EndsAt: &end, CreatedAt: clk.t, UpdatedAt: clk.t, Version: 1,
		}); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func (f *projectCalendarFixture) titles(t *testing.T, items []*domain.CalendarItem) []string {
	t.Helper()
	out := make([]string, 0, len(items))
	for _, it := range items {
		out = append(out, string(it.Kind)+":"+it.Title)
	}
	sort.Strings(out)
	return out
}

func (f *projectCalendarFixture) projectRange(t *testing.T) []string {
	t.Helper()
	items, err := f.s.CalendarEvents.RangeForProject(f.dayStart, f.dayEnd, f.project.ID)
	if err != nil {
		t.Fatalf("range for project: %v", err)
	}
	return f.titles(t, items)
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// A project's calendar is its calendars' events — one filed directly, every calendar of an
// account filed whole — plus its own tasks and dated notes. Nothing else leaks in, and the
// unscoped calendar is unchanged.
func TestRangeForProjectHoldsItsCalendarsTasksAndNotes(t *testing.T) {
	f := newProjectCalendarFixture(t)
	s := f.s

	if got := f.projectRange(t); len(got) != 0 {
		t.Fatalf("a project with nothing filed has an empty calendar, got %v", got)
	}

	if _, err := s.ProjectMembers.Add(f.project.ID, domain.MemberCalendar, f.filed.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ProjectMembers.Add(f.project.ID, domain.MemberCalendarAccount, f.account.ID); err != nil {
		t.Fatal(err)
	}
	// Filing a calendar the account already brings in must not show its events twice.
	if _, err := s.ProjectMembers.Add(f.project.ID, domain.MemberCalendar, f.accountCal1.ID); err != nil {
		t.Fatal(err)
	}

	due := time.Date(2026, 7, 4, 14, 0, 0, 0, time.UTC)
	mine, _ := s.Tasks.Create(CreateTaskInput{Title: "Ship it", DueAt: &due})
	s.Tasks.Create(CreateTaskInput{Title: "Someone else's", DueAt: &due})
	if _, err := s.ProjectMembers.Add(f.project.ID, domain.NodeTask, mine.ID); err != nil {
		t.Fatal(err)
	}
	date := "2026-07-04"
	note, _ := s.Notes.Create(CreateNoteInput{Title: "Launch day", ContentMD: "go", Date: &date})
	s.Notes.Create(CreateNoteInput{Title: "Other day note", ContentMD: "-", Date: &date})
	if _, err := s.ProjectMembers.Add(f.project.ID, domain.NodeNote, note.ID); err != nil {
		t.Fatal(err)
	}

	want := []string{"event:Fixtures", "event:Home", "event:Work", "note:Launch day", "task:Ship it"}
	if got := f.projectRange(t); !equalStrings(got, want) {
		t.Fatalf("project calendar:\n got %v\nwant %v", got, want)
	}

	all, err := s.CalendarEvents.Range(f.dayStart, f.dayEnd)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 8 {
		t.Fatalf("the unscoped calendar should hold all 4 events, 2 tasks and 2 notes, got %v", f.titles(t, all))
	}

	// Another project sees none of it.
	other, _ := s.Projects.Create(CreateProjectInput{AreaID: f.project.AreaID, Name: "Other"})
	items, err := s.CalendarEvents.RangeForProject(f.dayStart, f.dayEnd, other.ID)
	if err != nil || len(items) != 0 {
		t.Fatalf("another project's calendar should be empty, got %v (%v)", f.titles(t, items), err)
	}
}

// A calendar found later on a filed account joins the project without anyone filing it.
func TestProjectPicksUpAnAccountsNewCalendar(t *testing.T) {
	f := newProjectCalendarFixture(t)
	s := f.s
	if _, err := s.ProjectMembers.Add(f.project.ID, domain.MemberCalendarAccount, f.account.ID); err != nil {
		t.Fatal(err)
	}
	later, err := s.CalendarFeeds.Create(CreateFeedInput{
		Name: "Band", URL: "https://caldav.example.com/band/", Kind: domain.FeedKindCalDAV, AccountID: &f.account.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 7, 4, 20, 0, 0, 0, time.UTC)
	if err := s.CalendarEvents.Apply(&domain.CalendarEvent{
		ID: "ev-band", FeedID: later.ID, ICSUID: "u-band", Title: "Gig", StartsAt: start,
		CreatedAt: f.clk.t, UpdatedAt: f.clk.t, Version: 1,
	}); err != nil {
		t.Fatal(err)
	}
	want := []string{"event:Gig", "event:Home", "event:Work"}
	if got := f.projectRange(t); !equalStrings(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

// Calendars are not graph nodes, so filing one must not leave a `member` edge behind to draw as a
// ghost — on a local write, on a sync apply, or after a rebuild.
func TestCalendarMembershipsStayOutOfTheGraph(t *testing.T) {
	f := newProjectCalendarFixture(t)
	s := f.s
	if _, err := s.ProjectMembers.Add(f.project.ID, domain.MemberCalendar, f.filed.ID); err != nil {
		t.Fatal(err)
	}
	// As if pulled from another device.
	pulled := &domain.ProjectMember{
		ID: domain.MemberID(f.project.ID, domain.MemberCalendarAccount, f.account.ID), ProjectID: f.project.ID,
		EntityType: domain.MemberCalendarAccount, EntityID: f.account.ID,
		CreatedAt: f.clk.t, UpdatedAt: f.clk.t, Version: 1,
	}
	if err := s.ProjectMembers.Apply(pulled); err != nil {
		t.Fatal(err)
	}
	noCalendarEdges := func(when string) {
		t.Helper()
		g, err := s.Links.Full()
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range g.Edges {
			if domain.IsCalendarMember(e.TargetType) {
				t.Fatalf("%s: calendar membership mirrored into the graph: %+v", when, e)
			}
		}
	}
	noCalendarEdges("after add and apply")
	if _, _, err := s.Links.Rebuild(); err != nil {
		t.Fatal(err)
	}
	noCalendarEdges("after rebuild")
	// Removing one is still an ordinary membership removal.
	if err := s.ProjectMembers.Remove(f.project.ID, domain.MemberCalendar, f.filed.ID); err != nil {
		t.Fatalf("remove: %v", err)
	}
	members, _ := s.ProjectMembers.ListForProject(f.project.ID)
	if len(members) != 1 || members[0].EntityType != domain.MemberCalendarAccount {
		t.Fatalf("want only the account left, got %+v", members)
	}
}

// Removing a calendar, or its whole account, takes it out of every project — as synced
// tombstones, so the other devices drop it too.
func TestRemovingACalendarOrAccountUnfilesIt(t *testing.T) {
	f := newProjectCalendarFixture(t)
	s := f.s
	for _, m := range []struct{ typ, id string }{
		{domain.MemberCalendar, f.filed.ID},
		{domain.MemberCalendar, f.accountCal2.ID},
		{domain.MemberCalendarAccount, f.account.ID},
		{domain.MemberCalendar, f.unfiled.ID},
	} {
		if _, err := s.ProjectMembers.Add(f.project.ID, m.typ, m.id); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.CalendarFeeds.Delete(f.filed.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.CalendarAccounts.Delete(f.account.ID); err != nil {
		t.Fatal(err)
	}
	members, _ := s.ProjectMembers.ListForProject(f.project.ID)
	if len(members) != 1 || members[0].EntityID != f.unfiled.ID {
		t.Fatalf("only the untouched subscription should stay filed, got %+v", members)
	}
	dirty, _ := s.ProjectMembers.Dirty()
	tombstones := 0
	for _, m := range dirty {
		if m.DeletedAt != nil {
			tombstones++
		}
	}
	if tombstones != 3 {
		t.Fatalf("want 3 membership tombstones queued for push, got %d", tombstones)
	}
	if got := f.projectRange(t); !equalStrings(got, []string{"event:Holidays"}) {
		t.Fatalf("got %v", got)
	}
}

// When two rows turn out to be one calendar, the projects that held the dropped copy get the kept one.
func TestReassignMovesMembershipsToTheKeptRow(t *testing.T) {
	f := newProjectCalendarFixture(t)
	s := f.s
	other, _ := s.Projects.Create(CreateProjectInput{AreaID: f.project.AreaID, Name: "Other"})
	s.ProjectMembers.Add(f.project.ID, domain.MemberCalendar, f.accountCal2.ID)
	s.ProjectMembers.Add(other.ID, domain.MemberCalendar, f.accountCal2.ID)
	s.ProjectMembers.Add(other.ID, domain.MemberCalendar, f.accountCal1.ID) // already there: stays one row

	if err := s.ProjectMembers.Reassign(domain.MemberCalendar, f.accountCal2.ID, f.accountCal1.ID); err != nil {
		t.Fatal(err)
	}
	if left, _ := s.ProjectMembers.ListForEntity(domain.MemberCalendar, f.accountCal2.ID); len(left) != 0 {
		t.Fatalf("the dropped copy should be in no project, got %+v", left)
	}
	kept, _ := s.ProjectMembers.ListForEntity(domain.MemberCalendar, f.accountCal1.ID)
	if len(kept) != 2 {
		t.Fatalf("both projects should hold the kept copy once, got %+v", kept)
	}
}
