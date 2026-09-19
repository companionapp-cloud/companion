package bridge

import (
	"encoding/json"
	"testing"
	"time"

	"companion/core/domain"
)

func TestCalendarFeedsOverBridge(t *testing.T) {
	c, h := newTestCore(t)

	out, err := c.Invoke("calendar.feeds.create", []byte(`{"name":"Holidays","url":"https://example.com/h.ics","color":"#ff0"}`))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	var created domain.CalendarFeed
	if err := json.Unmarshal(out, &created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if created.ID == "" || created.Name != "Holidays" {
		t.Fatalf("unexpected feed %+v", created)
	}
	if h.count(calendarChangedEvent) != 1 {
		t.Errorf("expected calendar.changed emit, got %d", h.count(calendarChangedEvent))
	}

	out, err = c.Invoke("calendar.feeds.list", nil)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	var list []domain.CalendarFeed
	if err := json.Unmarshal(out, &list); err != nil || len(list) != 1 {
		t.Fatalf("list decode: %v len=%d", err, len(list))
	}

	if _, err := c.Invoke("calendar.feeds.delete", []byte(`{"id":"`+created.ID+`"}`)); err != nil {
		t.Fatalf("delete: %v", err)
	}
	out, _ = c.Invoke("calendar.feeds.list", nil)
	json.Unmarshal(out, &list)
	if len(list) != 0 {
		t.Fatalf("expected empty after delete, got %d", len(list))
	}
}

func TestCalendarRangeOverBridge(t *testing.T) {
	c, _ := newTestCore(t)
	// An empty range is valid and returns an empty array (not null).
	out, err := c.Invoke("calendar.range", []byte(`{"from":"2026-07-01T00:00:00Z","to":"2026-07-08T00:00:00Z"}`))
	if err != nil {
		t.Fatalf("range: %v", err)
	}
	var items []domain.CalendarItem
	if err := json.Unmarshal(out, &items); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if items == nil {
		t.Fatalf("expected non-nil slice")
	}
}

// A project's calendar over the bridge (PLAN §6.6): filing a subscription in a project puts its
// events in `calendar.range` for that project only, a calendar that isn't here can't be filed, and
// deleting the project with its content never deletes the calendar.
func TestProjectCalendarOverBridge(t *testing.T) {
	c, h := newTestCore(t)
	area := createArea(t, c, "Work")
	project := createProject(t, c, area, "Launch")
	other := createProject(t, c, area, "Other")

	start := time.Now().UTC().Truncate(24*time.Hour).AddDate(0, 0, 1).Add(9 * time.Hour)
	ics := "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:VEVENT\r\nUID:kickoff\r\n" +
		"DTSTAMP:" + start.Format("20060102T150405Z") + "\r\nDTSTART:" + start.Format("20060102T150405Z") + "\r\n" +
		"DTEND:" + start.Add(time.Hour).Format("20060102T150405Z") + "\r\nSUMMARY:Kickoff\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
	payload, _ := json.Marshal(map[string]any{"name": "Fixtures", "url": "", "icsText": ics})
	out, err := c.Invoke("calendar.feeds.create", payload)
	if err != nil {
		t.Fatalf("create feed: %v", err)
	}
	var feed domain.CalendarFeed
	json.Unmarshal(out, &feed)
	if _, err := c.Invoke("calendar.refresh", nil); err != nil {
		t.Fatalf("refresh: %v", err)
	}

	before := h.count(navChangedEvent)
	if _, err := c.Invoke("projects.addMember", []byte(`{"projectId":"`+project+`","entityType":"calendar","entityId":"`+feed.ID+`"}`)); err != nil {
		t.Fatalf("file the calendar: %v", err)
	}
	if h.count(navChangedEvent) != before+1 {
		t.Errorf("filing a calendar should emit nav.changed")
	}
	if _, err := c.Invoke("projects.addMember", []byte(`{"projectId":"`+project+`","entityType":"calendar","entityId":"no-such-feed"}`)); err == nil {
		t.Fatalf("a calendar that isn't here must not be filed")
	}
	if _, err := c.Invoke("projects.addMember", []byte(`{"projectId":"`+project+`","entityType":"calendar_account","entityId":"no-such-account"}`)); err == nil {
		t.Fatalf("an account that isn't here must not be filed")
	}

	titles := func(projectID string) []string {
		t.Helper()
		args, _ := json.Marshal(map[string]string{
			"from": start.Add(-24 * time.Hour).Format(time.RFC3339), "to": start.Add(24 * time.Hour).Format(time.RFC3339), "projectId": projectID,
		})
		out, err := c.Invoke("calendar.range", args)
		if err != nil {
			t.Fatalf("range: %v", err)
		}
		var items []domain.CalendarItem
		json.Unmarshal(out, &items)
		var got []string
		for _, it := range items {
			got = append(got, it.Title)
		}
		return got
	}
	if got := titles(project); len(got) != 1 || got[0] != "Kickoff" {
		t.Fatalf("the project's calendar should show the event, got %v", got)
	}
	if got := titles(other); len(got) != 0 {
		t.Fatalf("another project's calendar should be empty, got %v", got)
	}
	if got := titles(""); len(got) != 1 {
		t.Fatalf("the whole calendar is unchanged, got %v", got)
	}

	out, err = c.Invoke("projects.forEntity", []byte(`{"entityType":"calendar","entityId":"`+feed.ID+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	var in []domain.ProjectMember
	json.Unmarshal(out, &in)
	if len(in) != 1 || in[0].ProjectID != project {
		t.Fatalf("the calendar should know its project, got %+v", in)
	}

	if _, err := c.Invoke("projects.delete", []byte(`{"id":"`+project+`","deleteContent":true}`)); err != nil {
		t.Fatalf("delete project: %v", err)
	}
	out, _ = c.Invoke("calendar.feeds.list", nil)
	var feeds []domain.CalendarFeed
	json.Unmarshal(out, &feeds)
	if len(feeds) != 1 {
		t.Fatalf("deleting a project with its content must keep its calendars, have %d", len(feeds))
	}
}
