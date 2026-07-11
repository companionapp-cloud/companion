//go:build !js

package store

import (
	"testing"
	"time"

	"companion/core/domain"
)

func TestCalendarFeedCRUD(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	color := "#ff8800"
	f, err := s.CalendarFeeds.Create(CreateFeedInput{Name: "Holidays", URL: "https://example.com/holidays.ics", Color: &color})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if f.ID == "" || !f.Dirty {
		t.Fatalf("expected dirty feed with id, got %+v", f)
	}

	list, err := s.CalendarFeeds.List()
	if err != nil || len(list) != 1 {
		t.Fatalf("list: %v len=%d", err, len(list))
	}

	name := "Work"
	if _, err := s.CalendarFeeds.Update(f.ID, UpdateFeedInput{Name: &name}); err != nil {
		t.Fatalf("update: %v", err)
	}
	got, err := s.CalendarFeeds.Get(f.ID)
	if err != nil || got.Name != "Work" {
		t.Fatalf("get after update: %v name=%q", err, got.Name)
	}

	// A feed can also be created from uploaded .ics text instead of a URL.
	ics := "BEGIN:VCALENDAR\nEND:VCALENDAR"
	uploaded, err := s.CalendarFeeds.Create(CreateFeedInput{Name: "Uploaded", ICSText: &ics})
	if err != nil {
		t.Fatalf("create uploaded feed: %v", err)
	}
	if uploaded.URL != "" || uploaded.ICSText == nil || *uploaded.ICSText != ics {
		t.Fatalf("uploaded feed did not persist ics text: %+v", uploaded)
	}
	// A feed with neither url nor ics text is invalid.
	if _, err := s.CalendarFeeds.Create(CreateFeedInput{Name: "Empty"}); err == nil {
		t.Fatalf("expected validation error for feed with no source")
	}
	if err := s.CalendarFeeds.Delete(uploaded.ID); err != nil {
		t.Fatalf("delete uploaded: %v", err)
	}

	if err := s.CalendarFeeds.Delete(f.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := s.CalendarFeeds.Get(f.ID); err != ErrNotFound {
		t.Fatalf("expected ErrNotFound after delete, got %v", err)
	}
	list, _ = s.CalendarFeeds.List()
	if len(list) != 0 {
		t.Fatalf("expected empty list after delete, got %d", len(list))
	}
}

// TestCalendarEventsPullOnly verifies events are applied (never authored) and never appear
// as dirty push candidates.
func TestCalendarEventsPullOnly(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	// A feed must exist for Range's join to surface the event.
	f, err := s.CalendarFeeds.Create(CreateFeedInput{Name: "Cal", URL: "https://example.com/c.ics"})
	if err != nil {
		t.Fatalf("create feed: %v", err)
	}

	start := time.Date(2026, 7, 4, 9, 0, 0, 0, time.UTC)
	end := start.Add(time.Hour)
	ev := &domain.CalendarEvent{
		ID: "event-1", FeedID: f.ID, ICSUID: "uid-1", Title: "Weekly sync",
		StartsAt: start, EndsAt: &end, CreatedAt: clk.t, UpdatedAt: clk.t, Version: 1,
	}
	if err := s.CalendarEvents.Apply(ev); err != nil {
		t.Fatalf("apply event: %v", err)
	}
	dirty, err := s.CalendarEvents.Dirty()
	if err != nil {
		t.Fatalf("dirty: %v", err)
	}
	if len(dirty) != 0 {
		t.Fatalf("events must never be dirty, got %d", len(dirty))
	}
	got, err := s.CalendarEvents.GetAny("event-1")
	if err != nil || got.Title != "Weekly sync" {
		t.Fatalf("get event: %v %+v", err, got)
	}
}

// TestCalendarRangeMerge asserts Range merges events, due tasks, and dated notes into one
// sorted timeline within the window and excludes out-of-range / cancelled / trashed rows.
func TestCalendarRangeMerge(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 4, 8, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	feedColor := "#3388ff"
	f, _ := s.CalendarFeeds.Create(CreateFeedInput{Name: "Cal", URL: "https://example.com/c.ics", Color: &feedColor})

	dayStart := time.Date(2026, 7, 4, 0, 0, 0, 0, time.UTC)
	dayEnd := dayStart.Add(24 * time.Hour)

	// Event at 09:00 within the window, with a location + description.
	evStart := time.Date(2026, 7, 4, 9, 0, 0, 0, time.UTC)
	evEnd := evStart.Add(time.Hour)
	loc, desc := "Room 2", "Weekly team sync"
	if err := s.CalendarEvents.Apply(&domain.CalendarEvent{
		ID: "e1", FeedID: f.ID, ICSUID: "u1", Title: "Sync", StartsAt: evStart, EndsAt: &evEnd,
		Location: &loc, Description: &desc, CreatedAt: clk.t, UpdatedAt: clk.t, Version: 1,
	}); err != nil {
		t.Fatalf("apply event: %v", err)
	}
	// An event on another day must not appear.
	other := time.Date(2026, 7, 10, 9, 0, 0, 0, time.UTC)
	otherEnd := other.Add(time.Hour)
	s.CalendarEvents.Apply(&domain.CalendarEvent{
		ID: "e2", FeedID: f.ID, ICSUID: "u2", Title: "Later", StartsAt: other, EndsAt: &otherEnd,
		CreatedAt: clk.t, UpdatedAt: clk.t, Version: 1,
	})

	// A task due at 14:00 today.
	due := time.Date(2026, 7, 4, 14, 0, 0, 0, time.UTC)
	if _, err := s.Tasks.Create(CreateTaskInput{Title: "Draft plan", DueAt: &due}); err != nil {
		t.Fatalf("create task: %v", err)
	}
	// A cancelled task with a due date today must be excluded.
	cancelled := "cancelled"
	s.Tasks.Create(CreateTaskInput{Title: "Skip", DueAt: &due, Status: cancelled})

	// A daily note dated today.
	date := "2026-07-04"
	if _, err := s.Notes.Create(CreateNoteInput{Title: date, ContentMD: "hi", Date: &date}); err != nil {
		t.Fatalf("create note: %v", err)
	}

	items, err := s.CalendarEvents.Range(dayStart, dayEnd)
	if err != nil {
		t.Fatalf("range: %v", err)
	}
	if len(items) != 3 {
		t.Fatalf("expected 3 items (event, task, note), got %d: %+v", len(items), items)
	}
	// Sorted by start: note is all-day at midnight, event 09:00, task 14:00.
	if items[0].Kind != domain.ItemNote || items[1].Kind != domain.ItemEvent || items[2].Kind != domain.ItemTask {
		t.Fatalf("unexpected order/kinds: %v %v %v", items[0].Kind, items[1].Kind, items[2].Kind)
	}
	if items[1].Color == nil {
		t.Fatalf("event should carry its feed color")
	}
	// The event surfaces its location + description for the hover card / detail view; the
	// task and note leave them nil.
	if items[1].Location == nil || *items[1].Location != "Room 2" || items[1].Description == nil {
		t.Fatalf("event should carry location + description, got loc=%v desc=%v", items[1].Location, items[1].Description)
	}
	if items[0].Location != nil || items[2].Location != nil {
		t.Fatalf("note/task must not carry a location")
	}
}
