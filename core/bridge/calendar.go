package bridge

import (
	"encoding/json"
	"time"

	"companion/core/store"
	syncpkg "companion/core/sync"
)

// calendarChangedEvent lets calendar views refresh after a local feed change; data.changed
// covers cross-cutting refreshes (a sync pull applied server events) — the calendar UI
// subscribes to both (PLAN §6.7).
const calendarChangedEvent = "calendar.changed"

func (c *Core) emitCalendarChanged(id string) {
	c.emit(calendarChangedEvent, nil)
	c.emitDataChanged("calendar_feed", id)
}

func (c *Core) calendarFeedsList() ([]byte, error) {
	feeds, err := c.store.CalendarFeeds.List()
	if err != nil {
		return nil, err
	}
	return json.Marshal(feeds)
}

func (c *Core) calendarFeedsCreate(payload []byte) ([]byte, error) {
	var in store.CreateFeedInput
	if err := unmarshal(payload, &in); err != nil {
		return nil, err
	}
	f, err := c.store.CalendarFeeds.Create(in)
	if err != nil {
		return nil, err
	}
	c.emitCalendarChanged(f.ID)
	return json.Marshal(f)
}

func (c *Core) calendarFeedsUpdate(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
		store.UpdateFeedInput
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	f, err := c.store.CalendarFeeds.Update(args.ID, args.UpdateFeedInput)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitCalendarChanged(f.ID)
	return json.Marshal(f)
}

func (c *Core) calendarFeedsDelete(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if err := c.store.CalendarFeeds.Delete(args.ID); err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitCalendarChanged(args.ID)
	return json.Marshal(map[string]bool{"ok": true})
}

// calendarRefresh forces the server to re-fetch this account's ICS feeds now, then pulls the
// freshly-cloned events (PLAN §6.7) — the calendar view's manual "Refresh". When sync isn't
// configured (local-only), it just signals a refresh so the view re-queries local data.
func (c *Core) calendarRefresh() ([]byte, error) {
	if c.sync.baseURL == "" {
		c.emitCalendarChanged("")
		return json.Marshal(map[string]bool{"ok": true, "synced": false})
	}
	transport := syncpkg.NewHTTPTransport(c.sync.baseURL, c.sync.token)
	if err := transport.RefreshCalendars(); err != nil {
		return nil, err
	}
	// Pull the freshly-cloned events (and anything else pending), then refresh the view.
	if err := syncpkg.New(c.store, transport, nil).Sync(); err != nil {
		return nil, err
	}
	c.emitCalendarChanged("")
	c.emitDataChanged("", "")
	return json.Marshal(map[string]bool{"ok": true, "synced": true})
}

// calendarRange returns the merged, read-only calendar for a window: feed events, due
// tasks, and dated notes (PLAN §6.7). `from`/`to` are RFC3339 instants (half-open); the
// UI passes the visible day or week bounds. One shared query, identical on every client.
func (c *Core) calendarRange(payload []byte) ([]byte, error) {
	var args struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	from, err := time.Parse(time.RFC3339, args.From)
	if err != nil {
		return nil, err
	}
	to, err := time.Parse(time.RFC3339, args.To)
	if err != nil {
		return nil, err
	}
	items, err := c.store.CalendarEvents.Range(from, to)
	if err != nil {
		return nil, err
	}
	return json.Marshal(items)
}
