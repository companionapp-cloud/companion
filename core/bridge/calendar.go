package bridge

import (
	"bytes"
	"encoding/json"
	"log"
	"strings"
	"time"

	"companion/core/calendar"
	"companion/core/store"
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

// calendarRefresh fetches this account's ICS feeds on-device, reconciles their events into the
// local store, then syncs so the (encrypted) event changes propagate (PLAN §6.7, §E2EE). Moving
// the fetch client-side is what keeps event content and feed URLs opaque to the server. This is
// the calendar view's "Refresh", also triggered on mount/focus; between refreshes a device shows
// the last-fetched window. When sync isn't configured (local-only), it still parses uploaded-text
// feeds so their events render, with no network.
func (c *Core) calendarRefresh() ([]byte, error) {
	if err := c.fetchFeeds(); err != nil {
		return nil, err
	}
	if c.sync.baseURL == "" {
		c.emitCalendarChanged("")
		return json.Marshal(map[string]bool{"ok": true, "synced": false})
	}
	if err := c.newSyncEngine().Sync(); err != nil {
		return nil, err
	}
	c.emitCalendarChanged("")
	c.emitDataChanged("", "")
	return json.Marshal(map[string]bool{"ok": true, "synced": true})
}

// fetchFeeds expands every live feed and reconciles its events into the local store, marking
// changed occurrences dirty for the next push. A URL feed is fetched (natively, or via the server's
// blind proxy on web — see fetchICS); an uploaded-text feed is parsed in place with no network. A
// single feed's fetch/parse failure is logged and skipped so one bad feed can't wedge the rest.
func (c *Core) fetchFeeds() error {
	feeds, err := c.store.CalendarFeeds.List()
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	for _, f := range feeds {
		var body []byte
		switch {
		case f.ICSText != nil && strings.TrimSpace(*f.ICSText) != "":
			body = []byte(*f.ICSText)
		case strings.TrimSpace(f.URL) != "":
			b, err := c.fetchICS(f.URL)
			if err != nil {
				log.Printf("calendar: fetch feed %s: %v", f.ID, err)
				continue
			}
			body = b
		default:
			continue
		}
		events, err := calendar.ParseAndExpand(bytes.NewReader(body), f.ID, now)
		if err != nil {
			log.Printf("calendar: parse feed %s: %v", f.ID, err)
			continue
		}
		if _, err := c.store.CalendarEvents.ReconcileFeedEvents(f.ID, events); err != nil {
			return err
		}
	}
	return nil
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
