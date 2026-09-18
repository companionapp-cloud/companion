package caldav

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"companion/core/calendar"
	"companion/core/domain"
	"companion/core/store"
)

// Engine moves changes between the local store and a CalDAV provider (PLAN-caldav.md §4). It runs
// on native clients only. Every write it makes to the store is an ordinary dirty row, so whatever
// it learns from the provider reaches the user's other devices through normal (encrypted) sync.
type Engine struct {
	Store *store.Store
	Now   func() time.Time
}

// Conflict is a local change the provider refused because the event had changed there. The
// provider's copy was adopted; the UI tells the user their edit did not land.
type Conflict struct {
	FeedID string `json:"feedId"`
	Title  string `json:"title"`
}

// Result summarises one sync of one calendar.
type Result struct {
	Pushed    int
	Pulled    int
	Conflicts []Conflict
}

func (e *Engine) now() time.Time {
	if e.Now != nil {
		return e.Now().UTC()
	}
	return time.Now().UTC()
}

// SyncCalendars discovers the account's calendars and brings the local feed rows in line: a new
// collection becomes a feed, and a change in write privilege is recorded. Names and colors the
// user has since edited are left alone, and a collection that disappears is not removed here —
// dropping a calendar is the user's call. Returns the account's live feeds.
func (e *Engine) SyncCalendars(ctx context.Context, c *Client, account *domain.CalendarAccount) ([]*domain.CalendarFeed, error) {
	home := account.HomeSetURL
	if home == "" {
		h, err := c.Discover(ctx)
		if err != nil {
			return nil, err
		}
		home = h
		if _, err := e.Store.CalendarAccounts.Update(account.ID, store.UpdateAccountInput{HomeSetURL: &home}); err != nil {
			return nil, err
		}
		account.HomeSetURL = home
	}
	remote, err := c.Calendars(ctx, home)
	if err != nil {
		return nil, err
	}
	// Match against EVERY live feed by collection URL, not just the ones attached to this account.
	// A feed can lose its account link (see CalendarFeedsRepo.Apply); matching only attached feeds
	// is how one lost link used to become a second copy of every calendar. A collection URL is
	// unique to its calendar, so a feed that has it IS that calendar, whatever else it says.
	all, err := e.Store.CalendarFeeds.List()
	if err != nil {
		return nil, err
	}
	byURL := map[string][]*domain.CalendarFeed{}
	for _, f := range all {
		byURL[f.URL] = append(byURL[f.URL], f)
	}
	for _, cal := range remote {
		if matches := byURL[cal.URL]; len(matches) > 0 {
			keep, err := e.collapseDuplicates(matches)
			if err != nil {
				return nil, err
			}
			if err := e.Store.CalendarFeeds.AdoptCalDAV(keep.ID, account.ID, cal.ReadOnly); err != nil {
				return nil, err
			}
			continue
		}
		in := store.CreateFeedInput{
			Name: cal.Name, URL: cal.URL, Kind: domain.FeedKindCalDAV,
			AccountID: &account.ID, ReadOnly: cal.ReadOnly,
		}
		if cal.Color != "" {
			color := cal.Color
			in.Color = &color
		}
		if _, err := e.Store.CalendarFeeds.Create(in); err != nil {
			return nil, err
		}
	}
	return e.Store.CalendarFeeds.ListByAccount(account.ID)
}

// collapseDuplicates reduces several feeds for one calendar to one: the copy holding the most
// objects (it carries the etags, and any unpushed edits), oldest first on a tie. The others are
// removed along with their occurrences, which is what clears the doubled events.
func (e *Engine) collapseDuplicates(feeds []*domain.CalendarFeed) (*domain.CalendarFeed, error) {
	keep, keepCount := feeds[0], -1
	for _, f := range feeds { // List() is oldest first, so ">" keeps the oldest on a tie
		n, err := e.Store.CalendarObjects.CountByFeed(f.ID)
		if err != nil {
			return nil, err
		}
		if n > keepCount {
			keep, keepCount = f, n
		}
	}
	for _, f := range feeds {
		if f.ID == keep.ID {
			continue
		}
		if err := e.Store.CalendarFeeds.Delete(f.ID); err != nil && !errors.Is(err, store.ErrNotFound) {
			return nil, err
		}
	}
	return keep, nil
}

// SyncFeed pushes the calendar's pending objects, then pulls what changed on the provider.
func (e *Engine) SyncFeed(ctx context.Context, c *Client, feed *domain.CalendarFeed) (Result, error) {
	var res Result
	if !feed.IsCalDAV() {
		return res, nil
	}
	if err := e.push(ctx, c, feed, &res); err != nil {
		return res, err
	}
	if err := e.pull(ctx, c, feed, &res); err != nil {
		return res, err
	}
	return res, nil
}

// ---- push ----------------------------------------------------------------

func (e *Engine) push(ctx context.Context, c *Client, feed *domain.CalendarFeed, res *Result) error {
	pending, err := e.Store.CalendarObjects.Pending(feed.ID)
	if err != nil {
		return err
	}
	for _, o := range pending {
		err := e.pushOne(ctx, c, feed, o, res)
		switch {
		case err == nil:
		case errors.Is(err, ErrUnauthorized):
			// A bad credential fails every object the same way; stop and let the account report it.
			return err
		case ctx.Err() != nil:
			return ctx.Err()
		default:
			// One object failing (a server that rejects its ICS, a blip) must not block the rest.
			// It stays pending and is retried on the next sync.
			if err := e.recordPushError(o, err); err != nil {
				return err
			}
		}
	}
	return nil
}

func (e *Engine) pushOne(ctx context.Context, c *Client, feed *domain.CalendarFeed, o *domain.CalendarObject, res *Result) error {
	switch o.PushState {
	case domain.PushPendingDelete:
		if o.Href == "" {
			// Created and deleted before any device reached the provider: nothing to undo there.
			return e.forget(o)
		}
		err := c.Delete(ctx, o.Href, o.ETag)
		switch {
		case err == nil, errors.Is(err, ErrNotFound):
			res.Pushed++
			return e.forget(o)
		case errors.Is(err, ErrPreconditionFailed):
			return e.adoptRemote(ctx, c, o, res)
		}
		return err

	case domain.PushPendingCreate, domain.PushPendingUpdate:
		var etag string
		var err error
		if o.Href == "" {
			o.Href = ObjectURL(feed.URL, o.UID)
			etag, err = c.Create(ctx, o.Href, o.ICS)
		} else if o.PushState == domain.PushPendingCreate {
			etag, err = c.Create(ctx, o.Href, o.ICS)
		} else {
			etag, err = c.Update(ctx, o.Href, o.ICS, o.ETag)
		}
		switch {
		case err == nil:
			res.Pushed++
			o.ETag, o.PushState, o.PushError = etag, domain.PushSynced, nil
			return e.Store.CalendarObjects.Put(o)
		case errors.Is(err, ErrPreconditionFailed), errors.Is(err, ErrNotFound):
			// 412: it changed (or, for a create, already exists) on the provider.
			// 404 on update: it was deleted there. Either way the provider's state wins.
			return e.adoptRemote(ctx, c, o, res)
		}
		return err
	}
	return nil
}

// adoptRemote resolves a refused write by taking the provider's copy. If that copy already says
// what we were trying to say — another of the user's devices pushed the same pending row first —
// it is a success, not a conflict.
func (e *Engine) adoptRemote(ctx context.Context, c *Client, o *domain.CalendarObject, res *Result) error {
	remote, err := c.Get(ctx, o.Href)
	if errors.Is(err, ErrNotFound) {
		if o.PushState != domain.PushPendingDelete {
			res.Conflicts = append(res.Conflicts, Conflict{FeedID: o.FeedID, Title: objectTitle(o.ICS)})
		}
		return e.forget(o)
	}
	if err != nil {
		return err
	}
	if o.PushState == domain.PushPendingDelete || !calendar.SameContent(o.ICS, remote.ICS) {
		res.Conflicts = append(res.Conflicts, Conflict{FeedID: o.FeedID, Title: objectTitle(o.ICS)})
	}
	o.ICS, o.ETag, o.Href = remote.ICS, remote.ETag, remote.Href
	o.PushState, o.PushError = domain.PushSynced, nil
	if info, err := calendar.InspectObject(remote.ICS); err == nil {
		o.Recurring = info.Recurring
	}
	if err := e.Store.CalendarObjects.Put(o); err != nil {
		return err
	}
	_, err = e.Store.CalendarEvents.DeriveFromObject(o)
	return err
}

// forget tombstones an object and its occurrences.
func (e *Engine) forget(o *domain.CalendarObject) error {
	if err := e.Store.CalendarObjects.Tombstone(o.ID); err != nil {
		return err
	}
	_, err := e.Store.CalendarEvents.ReconcileObjectEvents(o.FeedID, o.UID, nil)
	return err
}

// recordPushError notes why an object is stuck. Unchanged messages are not rewritten, so a
// persistently failing object does not re-sync its row on every attempt.
func (e *Engine) recordPushError(o *domain.CalendarObject, cause error) error {
	msg := cause.Error()
	if o.PushError != nil && *o.PushError == msg {
		return nil
	}
	o.PushError = &msg
	return e.Store.CalendarObjects.Put(o)
}

// ---- pull ----------------------------------------------------------------

func (e *Engine) pull(ctx context.Context, c *Client, feed *domain.CalendarFeed, res *Result) error {
	ctag, err := c.CTag(ctx, feed.URL)
	if err != nil {
		return err
	}
	if ctag != "" {
		last, err := e.Store.CalendarFeeds.CTag(feed.ID)
		if err != nil {
			return err
		}
		if last == ctag {
			return nil // nothing changed on the provider since this device last looked
		}
	}

	now := e.now()
	entries, err := c.ListETags(ctx, feed.URL, now.Add(-calendar.Window), now.Add(calendar.Window))
	if err != nil {
		return err
	}
	local, err := e.Store.CalendarObjects.ListByFeed(feed.ID)
	if err != nil {
		return err
	}
	byHref := map[string]*domain.CalendarObject{}
	for _, o := range local {
		if o.Href != "" {
			byHref[o.Href] = o
		}
	}

	listed := map[string]bool{}
	var fetch []string
	for _, en := range entries {
		listed[en.Href] = true
		o, known := byHref[en.Href]
		switch {
		case !known:
			fetch = append(fetch, en.Href)
		case o.PushState.Pending():
			// A local change is waiting; the push (and its etag check) decides, not the pull.
		case o.ETag != en.ETag:
			fetch = append(fetch, en.Href)
		}
	}

	if len(fetch) > 0 {
		objs, err := c.MultiGet(ctx, feed.URL, fetch)
		if err != nil {
			return err
		}
		for _, remote := range objs {
			info, err := calendar.InspectObject(remote.ICS)
			if err != nil || info.UID == "" {
				continue // not an event we can represent; skip rather than fail the calendar
			}
			id := calendar.ObjectID(feed.ID, info.UID)
			if cur, ok := local[id]; ok && cur.PushState.Pending() {
				continue
			}
			o := &domain.CalendarObject{
				ID: id, FeedID: feed.ID, UID: info.UID, Href: remote.Href, ETag: remote.ETag,
				ICS: remote.ICS, Recurring: info.Recurring, PushState: domain.PushSynced,
			}
			if err := e.Store.CalendarObjects.Put(o); err != nil {
				return err
			}
			if _, err := e.Store.CalendarEvents.DeriveFromObject(o); err != nil {
				return err
			}
			local[id] = o
			res.Pulled++
		}
	}

	// Anything we hold that the provider no longer lists was deleted there (or slid out of the
	// window, in which case it has no occurrences to show anyway).
	for _, o := range local {
		if o.Href == "" || o.PushState.Pending() || listed[o.Href] {
			continue
		}
		if err := e.forget(o); err != nil {
			return err
		}
		res.Pulled++
	}

	if ctag != "" {
		return e.Store.CalendarFeeds.SetCTag(feed.ID, ctag)
	}
	return nil
}

// objectTitle is the summary of an object, for naming it in a conflict notice.
func objectTitle(ics string) string {
	if info, err := calendar.InspectObject(ics); err == nil && strings.TrimSpace(info.Title) != "" {
		return info.Title
	}
	return "An event"
}

// FriendlyError turns a sync failure into something to show beside an account.
func FriendlyError(err error) string {
	var se *StatusError
	switch {
	case err == nil:
		return ""
	case errors.Is(err, ErrForbidden):
		return "The calendar server refused that change. The calendar may be read-only."
	case errors.Is(err, ErrUnauthorized):
		return "The server rejected the username or password. Some providers (iCloud, Fastmail) need an app-specific password."
	case errors.Is(err, ErrNoCalendars):
		return "No calendars were found at that address."
	case errors.As(err, &se):
		return fmt.Sprintf("The calendar server answered with an error (%d).", se.Status)
	}
	return err.Error()
}
