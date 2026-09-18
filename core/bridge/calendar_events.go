package bridge

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"companion/core/calendar"
	"companion/core/domain"
	"companion/core/store"
)

// Event editing (PLAN-caldav.md §5). These methods are the same on every platform: they only ever
// change local rows. The calendar object is patched, marked pending and its occurrences re-derived,
// all of which sync (encrypted) like any other data. Reaching the provider is a separate, native-only
// step (caldav_native.go) — which is how the web client can edit a calendar it cannot talk to.

// calendarAccountView is what the UI sees of an account: never the credential.
type calendarAccountView struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	ServerURL string `json:"serverUrl"`
	Username  string `json:"username"`
	// AuthKind is "basic" or "oauth-google"; an OAuth account is reconnected, not re-passworded.
	AuthKind string `json:"authKind"`
	// HasCredential is whether THIS device can sync the account: it holds the credential and,
	// for an OAuth account, was built with the client id the grant belongs to.
	HasCredential bool                   `json:"hasCredential"`
	LastError     *string                `json:"lastError,omitempty"`
	Calendars     []*domain.CalendarFeed `json:"calendars"`
}

func (c *Core) accountView(a *domain.CalendarAccount) (*calendarAccountView, error) {
	feeds, err := c.store.CalendarFeeds.ListByAccount(a.ID)
	if err != nil {
		return nil, err
	}
	return &calendarAccountView{
		ID: a.ID, Name: a.Name, ServerURL: a.ServerURL, Username: a.Username,
		AuthKind: a.AuthKind, HasCredential: c.canSyncAccount(a), LastError: a.LastError, Calendars: feeds,
	}, nil
}

func (c *Core) calendarAccountsList() ([]byte, error) {
	accounts, err := c.store.CalendarAccounts.List()
	if err != nil {
		return nil, err
	}
	out := make([]*calendarAccountView, 0, len(accounts))
	for _, a := range accounts {
		v, err := c.accountView(a)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return json.Marshal(out)
}

// calendarAccountsRemove forgets an account and everything pulled from it, on every device.
// Nothing is deleted from the provider.
func (c *Core) calendarAccountsRemove(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	a, err := c.store.CalendarAccounts.Get(args.ID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	if a.CredentialRef != nil && c.secrets != nil {
		_ = c.secrets.DeleteSecret(*a.CredentialRef)
	}
	if err := c.store.CalendarAccounts.Delete(a.ID); err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitCalendarChanged("")
	return json.Marshal(map[string]bool{"ok": true})
}

// calendarCapabilities tells the UI what this client can do, so it can hide "Add account" where
// the provider is unreachable (web) instead of offering a button that always fails.
func (c *Core) calendarCapabilities() ([]byte, error) {
	// google: this build carries a Google OAuth client id AND can reach the provider.
	_, google := c.oauthProvider("google")
	return json.Marshal(map[string]bool{"caldav": caldavSupported, "google": caldavSupported && google})
}

// writableFeed loads a feed and checks events may be written to it.
func (c *Core) writableFeed(id string) (*domain.CalendarFeed, error) {
	f, err := c.store.CalendarFeeds.Get(id)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	switch {
	case !f.IsCalDAV():
		return nil, errors.New("this calendar is a read-only subscription")
	case f.ReadOnly:
		return nil, errors.New("you don't have permission to change this calendar")
	}
	return f, nil
}

func (c *Core) calendarEventsCreate(payload []byte) ([]byte, error) {
	var args struct {
		FeedID string `json:"feedId"`
		calendar.EventFields
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.Title) == "" {
		return nil, errors.New("a title is required")
	}
	feed, err := c.writableFeed(args.FeedID)
	if err != nil {
		return nil, err
	}
	uid := calendar.NewUID()
	ics, err := calendar.NewObject(uid, args.EventFields, time.Now())
	if err != nil {
		return nil, err
	}
	o := &domain.CalendarObject{
		ID: calendar.ObjectID(feed.ID, uid), FeedID: feed.ID, UID: uid, ICS: ics,
		PushState: domain.PushPendingCreate,
	}
	if err := c.saveObject(o); err != nil {
		return nil, err
	}
	return json.Marshal(map[string]any{"ok": true, "eventId": calendar.EventID(feed.ID, uid, args.StartsAt)})
}

// objectForEvent resolves an occurrence id to its (writable) calendar object.
func (c *Core) objectForEvent(eventID string) (*domain.CalendarEvent, *domain.CalendarObject, error) {
	ev, err := c.store.CalendarEvents.GetLive(eventID)
	if err != nil {
		return nil, nil, mapStoreErr(err)
	}
	if _, err := c.writableFeed(ev.FeedID); err != nil {
		return nil, nil, err
	}
	o, err := c.store.CalendarObjects.Get(calendar.ObjectID(ev.FeedID, ev.ICSUID))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, nil, errors.New("this event is still syncing — try again in a moment")
		}
		return nil, nil, err
	}
	return ev, o, nil
}

// calendarEventsGet returns what the editor needs beyond what calendar.range already gave it: the
// event's repeat rule. Works for read-only events too (the detail view can show "repeats weekly").
func (c *Core) calendarEventsGet(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	ev, err := c.store.CalendarEvents.GetLive(args.ID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	out := map[string]any{"id": ev.ID, "repeat": nil}
	if o, err := c.store.CalendarObjects.Get(calendar.ObjectID(ev.FeedID, ev.ICSUID)); err == nil {
		if info, err := calendar.InspectObject(o.ICS); err == nil {
			out["repeat"] = info.Repeat
		}
	}
	return json.Marshal(out)
}

func (c *Core) calendarEventsUpdate(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
		calendar.EventPatch
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if args.Title != nil && strings.TrimSpace(*args.Title) == "" {
		return nil, errors.New("a title is required")
	}
	ev, o, err := c.objectForEvent(args.ID)
	if err != nil {
		return nil, err
	}
	// The UI edits the occurrence it shows; for a repeating event the core turns that into a
	// change to the whole series, and needs to know which occurrence it was.
	args.EventPatch.OccurrenceStart = &ev.StartsAt
	ics, err := calendar.ApplyEdit(o.ICS, args.EventPatch, time.Now())
	if err != nil {
		return nil, err
	}
	o.ICS = ics
	// An object the provider has never seen is still a create, however often it is edited.
	if o.PushState != domain.PushPendingCreate {
		o.PushState = domain.PushPendingUpdate
	}
	if err := c.saveObject(o); err != nil {
		return nil, err
	}
	return json.Marshal(map[string]bool{"ok": true})
}

// calendarEventsDelete removes an event. For a repeating event scope decides between this one
// occurrence ("occurrence", the default) and every occurrence ("series").
func (c *Core) calendarEventsDelete(payload []byte) ([]byte, error) {
	var args struct {
		ID    string `json:"id"`
		Scope string `json:"scope"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	ev, o, err := c.objectForEvent(args.ID)
	if err != nil {
		return nil, err
	}
	if o.Recurring && args.Scope != "series" {
		ics, err := calendar.ExcludeOccurrence(o.ICS, ev.StartsAt, time.Now())
		if err != nil {
			return nil, err
		}
		o.ICS = ics
		if o.PushState != domain.PushPendingCreate {
			o.PushState = domain.PushPendingUpdate
		}
	} else {
		o.PushState = domain.PushPendingDelete
	}
	if err := c.saveObject(o); err != nil {
		return nil, err
	}
	return json.Marshal(map[string]bool{"ok": true})
}

// saveObject writes a locally-changed object, re-derives its occurrences, and tells the UI. The
// change is visible at once; reaching the provider happens on the next push.
func (c *Core) saveObject(o *domain.CalendarObject) error {
	if info, err := calendar.InspectObject(o.ICS); err == nil {
		o.Recurring = info.Recurring
	}
	o.PushError = nil
	if err := c.store.CalendarObjects.Put(o); err != nil {
		return err
	}
	if _, err := c.store.CalendarEvents.DeriveFromObject(o); err != nil {
		return err
	}
	c.emitCalendarChanged(o.FeedID)
	return nil
}

// calendarPush sends pending calendar changes on their way without the cost of a full refresh:
// straight to the provider on a native client, and into sync either way so that a client which
// cannot reach the provider (web) hands the change to one that can.
func (c *Core) calendarPush() ([]byte, error) {
	conflicts, err := c.syncCalDAV(true)
	if err != nil {
		return nil, err
	}
	synced := false
	if c.sync.baseURL != "" {
		if err := c.newSyncEngine().Sync(); err != nil {
			return nil, err
		}
		synced = true
	}
	c.emitCalendarChanged("")
	return json.Marshal(map[string]any{"ok": true, "synced": synced, "conflicts": conflicts})
}
