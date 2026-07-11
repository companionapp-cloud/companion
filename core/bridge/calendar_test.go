package bridge

import (
	"encoding/json"
	"testing"

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
