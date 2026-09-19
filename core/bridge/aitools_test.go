package bridge

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"companion/core/caldav/caldavtest"
	"companion/core/domain"
)

// TestAssistantCalendarWritesTakeTheUIPath checks the assistant's calendar tools write events the
// way the calendar UI does — shown at once, pending, then pushed to the provider without anyone
// pressing refresh — and that a chat preview can load the result by id.
func TestAssistantCalendarWritesTakeTheUIPath(t *testing.T) {
	prevDelay := calendarPushDelay
	calendarPushDelay = 10 * time.Millisecond
	t.Cleanup(func() { calendarPushDelay = prevDelay })

	s := caldavtest.New("sam", "app-password")
	defer s.Close()
	work := s.AddCalendar("work", "Work", "#336699", false)
	s.AddCalendar("holidays", "Holidays", "", true)

	c, h := newTestCore(t)
	c.SetSecretStore(mapSecrets{})
	// Runs before the store closes (cleanups are last-in, first-out).
	t.Cleanup(func() {
		c.calPushMu.Lock()
		defer c.calPushMu.Unlock()
		if c.calPushTimer != nil {
			c.calPushTimer.Stop()
		}
	})
	acct := invoke[calendarAccountView](t, c, "calendar.accounts.add", map[string]string{
		"name": "My server", "serverUrl": s.URL, "username": "sam", "password": "app-password",
	})
	var workFeed, holidayFeed string
	for _, f := range acct.Calendars {
		switch f.Name {
		case "Work":
			workFeed = f.ID
		case "Holidays":
			holidayFeed = f.ID
		}
	}

	tools := c.toolRegistry()
	ctx := context.Background()
	start := time.Now().UTC().Truncate(time.Hour).Add(48 * time.Hour)
	out, err := tools.Invoke(ctx, "create_event", json.RawMessage(`{"calendarId":"`+workFeed+`","title":"Planning","startsAt":"`+start.Format(time.RFC3339)+`","location":"Room 2"}`))
	if err != nil {
		t.Fatalf("create_event: %v", err)
	}
	var created struct {
		ID       string `json:"id"`
		Calendar string `json:"calendar"`
	}
	if err := json.Unmarshal([]byte(out), &created); err != nil || created.ID == "" || created.Calendar != "Work" {
		t.Fatalf("create_event result %s: %v", out, err)
	}
	items := calendarItems(t, c)
	if len(items) != 1 || items[0].SourceID != created.ID || !items[0].Pending || !items[0].Editable {
		t.Fatalf("the new event should show at once, pending and editable: %+v", items)
	}
	if h.count(calendarChangedEvent) == 0 {
		t.Error("open calendar views were not told about the new event")
	}

	// Nobody calls calendar.push: the assistant's edit goes out on its own.
	waitFor(t, "the provider to receive the event", func() bool {
		for _, ics := range s.Objects(work) {
			if strings.Contains(ics, "SUMMARY:Planning") {
				return true
			}
		}
		return false
	})

	// Moving it returns the moved occurrence, whose id is new.
	moved := start.Add(2 * time.Hour)
	out, err = tools.Invoke(ctx, "update_event", json.RawMessage(`{"id":"`+created.ID+`","startsAt":"`+moved.Format(time.RFC3339)+`"}`))
	if err != nil {
		t.Fatalf("update_event: %v", err)
	}
	var updated struct {
		ID    string `json:"id"`
		Start string `json:"start"`
		End   string `json:"end"`
	}
	if err := json.Unmarshal([]byte(out), &updated); err != nil || updated.ID == "" || updated.ID == created.ID {
		t.Fatalf("update_event result %s: %v", out, err)
	}
	if got, _ := time.Parse(time.RFC3339, updated.Start); !got.Equal(moved) {
		t.Errorf("moved start = %s, want %s", updated.Start, moved)
	}
	if got, _ := time.Parse(time.RFC3339, updated.End); !got.Equal(moved.Add(time.Hour)) {
		t.Errorf("a move should keep the hour-long duration; end = %s", updated.End)
	}
	waitFor(t, "the provider to receive the move", func() bool {
		for _, ics := range s.Objects(work) {
			if strings.Contains(ics, "SUMMARY:Planning") && strings.Contains(ics, moved.Format("20060102T150405Z")) {
				return true
			}
		}
		return false
	})

	// What a chat preview loads by id: the event as the calendar shows it, and its calendar's name.
	detail := invoke[struct {
		Item         *domain.CalendarItem `json:"item"`
		CalendarName string               `json:"calendarName"`
	}](t, c, "calendar.events.get", map[string]string{"id": updated.ID})
	if detail.Item == nil || detail.Item.Title != "Planning" || detail.CalendarName != "Work" || !detail.Item.Editable ||
		detail.Item.Location == nil || *detail.Item.Location != "Room 2" {
		t.Errorf("calendar.events.get = %+v", detail)
	}

	// A read-only calendar refuses, with the same answer the UI gets.
	if _, err := tools.Invoke(ctx, "create_event", json.RawMessage(`{"calendarId":"`+holidayFeed+`","title":"x","startsAt":"`+start.Format(time.RFC3339)+`"}`)); err == nil {
		t.Error("create_event in a read-only calendar should fail")
	}
}

// waitFor polls cond until it holds, failing the test after a few seconds.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
