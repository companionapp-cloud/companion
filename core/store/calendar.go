package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"companion/core/calendar"
	"companion/core/domain"
	"companion/core/sync/protocol"

	"github.com/google/uuid"
)

// dateLayout is the 'YYYY-MM-DD' form used by note.date (a local all-day marker).
const dateLayout = "2006-01-02"

// ---- calendar feeds ------------------------------------------------------

// CalendarFeedsRepo is the CRUD + sync repository for calendars (PLAN §6.7): ICS subscriptions,
// uploaded .ics files, and CalDAV collections (PLAN-caldav.md). Feeds are ordinary user data and
// sync bidirectionally; the client fetches them and derives the CalendarEvent rows.
type CalendarFeedsRepo struct {
	db    Driver
	clock domain.Clock
}

const feedColumns = `id, name, kind, account_id, read_only, url, ics_text, color, created_at, updated_at, deleted_at, version, dirty`

// CreateFeedInput carries the client-supplied fields for a new feed: a name plus a source,
// either a subscription URL or the raw text of an uploaded .ics file.
type CreateFeedInput struct {
	Name    string  `json:"name"`
	URL     string  `json:"url"`
	ICSText *string `json:"icsText,omitempty"`
	Color   *string `json:"color,omitempty"`
	// Kind, AccountID and ReadOnly describe a CalDAV calendar. They are set by account discovery,
	// never by the UI, so they are not part of the JSON input.
	Kind      string  `json:"-"`
	AccountID *string `json:"-"`
	ReadOnly  bool    `json:"-"`
}

// UpdateFeedInput carries partial updates; nil fields are left unchanged.
type UpdateFeedInput struct {
	Name    *string `json:"name,omitempty"`
	URL     *string `json:"url,omitempty"`
	ICSText *string `json:"icsText,omitempty"`
	Color   *string `json:"color,omitempty"`
	// ReadOnly is refreshed by a CalDAV rescan when the login's privileges change.
	ReadOnly *bool `json:"-"`
}

// Create inserts a new feed (UUIDv7 id, version 0, dirty).
func (r *CalendarFeedsRepo) Create(in CreateFeedInput) (*domain.CalendarFeed, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return nil, fmt.Errorf("generate uuid: %w", err)
	}
	now := r.clock.Now().UTC()
	kind := in.Kind
	if kind == "" {
		kind = domain.FeedKindICS
	}
	f := &domain.CalendarFeed{
		ID: id.String(), Name: in.Name, Kind: kind, AccountID: in.AccountID, ReadOnly: in.ReadOnly,
		URL: in.URL, ICSText: in.ICSText, Color: in.Color,
		CreatedAt: now, UpdatedAt: now, Version: 0, Dirty: true,
	}
	if err := f.Validate(); err != nil {
		return nil, err
	}
	if _, err := r.db.Exec(
		`INSERT INTO calendar_feeds (id, name, kind, account_id, read_only, url, ics_text, color, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
		f.ID, f.Name, f.Kind, f.AccountID, boolToInt(f.ReadOnly), f.URL, f.ICSText, f.Color,
		f.CreatedAt.Format(timeFormat), f.UpdatedAt.Format(timeFormat), f.Version, boolToInt(f.Dirty),
	); err != nil {
		return nil, fmt.Errorf("insert calendar feed: %w", err)
	}
	return f, nil
}

// Get returns a single non-deleted feed by id, or ErrNotFound.
func (r *CalendarFeedsRepo) Get(id string) (*domain.CalendarFeed, error) {
	rows, err := r.db.Query(`SELECT `+feedColumns+` FROM calendar_feeds WHERE id = ? AND deleted_at IS NULL;`, id)
	if err != nil {
		return nil, fmt.Errorf("query calendar feed: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanFeed(rows)
}

// List returns all non-deleted feeds, newest first.
func (r *CalendarFeedsRepo) List() ([]*domain.CalendarFeed, error) {
	rows, err := r.db.Query(
		`SELECT ` + feedColumns + ` FROM calendar_feeds WHERE deleted_at IS NULL ORDER BY created_at ASC, id ASC;`)
	if err != nil {
		return nil, fmt.Errorf("query calendar feeds: %w", err)
	}
	defer rows.Close()
	out := []*domain.CalendarFeed{}
	for rows.Next() {
		f, err := scanFeed(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// Update applies partial changes, bumps updated_at, marks dirty.
func (r *CalendarFeedsRepo) Update(id string, in UpdateFeedInput) (*domain.CalendarFeed, error) {
	f, err := r.Get(id)
	if err != nil {
		return nil, err
	}
	if f.IsCalDAV() {
		// A CalDAV calendar's source is its collection URL, owned by account discovery. Only its
		// name and color are the user's to change.
		in.URL, in.ICSText = nil, nil
	}
	if in.Name != nil {
		f.Name = *in.Name
	}
	if in.URL != nil {
		f.URL = *in.URL
	}
	if in.ICSText != nil {
		f.ICSText = in.ICSText
	}
	if in.Color != nil {
		f.Color = in.Color
	}
	if in.ReadOnly != nil {
		f.ReadOnly = *in.ReadOnly
	}
	f.UpdatedAt = r.clock.Now().UTC()
	f.Dirty = true
	if err := f.Validate(); err != nil {
		return nil, err
	}
	res, err := r.db.Exec(
		`UPDATE calendar_feeds SET name = ?, url = ?, ics_text = ?, color = ?, read_only = ?, updated_at = ?, dirty = 1
		 WHERE id = ? AND deleted_at IS NULL;`,
		f.Name, f.URL, f.ICSText, f.Color, boolToInt(f.ReadOnly), f.UpdatedAt.Format(timeFormat), id,
	)
	if err != nil {
		return nil, fmt.Errorf("update calendar feed: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return nil, ErrNotFound
	}
	return f, nil
}

// Delete soft-deletes a feed and tombstones its events locally so the removal syncs to every
// device. Under client-side fetching (PLAN §E2EE) the client owns the events, so it — not the
// server — is responsible for cleaning them up when a feed goes away.
func (r *CalendarFeedsRepo) Delete(id string) error {
	now := r.clock.Now().UTC()
	res, err := r.db.Exec(
		`UPDATE calendar_feeds SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ? AND deleted_at IS NULL;`,
		now.Format(timeFormat), now.Format(timeFormat), id,
	)
	if err != nil {
		return fmt.Errorf("delete calendar feed: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	// Tombstone the feed's live events (dirty, so they push as deletions).
	if _, err := r.db.Exec(
		`UPDATE calendar_events SET deleted_at = ?, updated_at = ?, dirty = 1
		 WHERE feed_id = ? AND deleted_at IS NULL;`,
		now.Format(timeFormat), now.Format(timeFormat), id,
	); err != nil {
		return fmt.Errorf("tombstone feed events: %w", err)
	}
	// A CalDAV calendar's objects go with it. This only forgets them locally and on other
	// devices — nothing is deleted from the provider.
	if _, err := r.db.Exec(
		`UPDATE calendar_objects SET deleted_at = ?, updated_at = ?, push_state = 'synced', dirty = 1
		 WHERE feed_id = ? AND deleted_at IS NULL;`,
		now.Format(timeFormat), now.Format(timeFormat), id,
	); err != nil {
		return fmt.Errorf("tombstone feed objects: %w", err)
	}
	if _, err := r.db.Exec(`DELETE FROM caldav_feed_state WHERE feed_id = ?;`, id); err != nil {
		return fmt.Errorf("clear feed state: %w", err)
	}
	// The calendar leaves every project it was in (PLAN §6.6). A calendar membership has no graph
	// edge, so tombstoning the row is all there is to it.
	if _, err := r.db.Exec(
		`UPDATE project_members SET deleted_at = ?, updated_at = ?, dirty = 1
		 WHERE entity_type = ? AND entity_id = ? AND deleted_at IS NULL;`,
		now.Format(timeFormat), now.Format(timeFormat), domain.MemberCalendar, id,
	); err != nil {
		return fmt.Errorf("remove feed from projects: %w", err)
	}
	return nil
}

// AdoptCalDAV (re)attaches a feed to a CalDAV account. It repairs calendars orphaned by the
// stripping described in Apply, and is a no-op for a feed that is already attached correctly.
func (r *CalendarFeedsRepo) AdoptCalDAV(id, accountID string, readOnly bool) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	_, err := r.db.Exec(
		`UPDATE calendar_feeds SET kind = 'caldav', account_id = ?, read_only = ?, updated_at = ?, dirty = 1
		 WHERE id = ? AND deleted_at IS NULL AND (kind != 'caldav' OR account_id IS NULL OR account_id != ? OR read_only != ?);`,
		accountID, boolToInt(readOnly), now, id, accountID, boolToInt(readOnly))
	if err != nil {
		return fmt.Errorf("adopt caldav feed: %w", err)
	}
	return nil
}

// ListByAccount returns the live CalDAV calendars of one account.
func (r *CalendarFeedsRepo) ListByAccount(accountID string) ([]*domain.CalendarFeed, error) {
	rows, err := r.db.Query(
		`SELECT `+feedColumns+` FROM calendar_feeds WHERE account_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC;`, accountID)
	if err != nil {
		return nil, fmt.Errorf("query account feeds: %w", err)
	}
	defer rows.Close()
	out := []*domain.CalendarFeed{}
	for rows.Next() {
		f, err := scanFeed(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// CTag returns the collection tag this device last pulled for a CalDAV feed ("" if never).
func (r *CalendarFeedsRepo) CTag(feedID string) (string, error) {
	rows, err := r.db.Query(`SELECT ctag FROM caldav_feed_state WHERE feed_id = ?;`, feedID)
	if err != nil {
		return "", fmt.Errorf("query ctag: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		return "", rows.Err()
	}
	var ctag string
	if err := rows.Scan(&ctag); err != nil {
		return "", fmt.Errorf("scan ctag: %w", err)
	}
	return ctag, nil
}

// SetCTag records the collection tag after a completed pull. Device-local: never synced.
func (r *CalendarFeedsRepo) SetCTag(feedID, ctag string) error {
	if _, err := r.db.Exec(
		`INSERT INTO caldav_feed_state (feed_id, ctag) VALUES (?, ?)
		 ON CONFLICT(feed_id) DO UPDATE SET ctag = excluded.ctag;`, feedID, ctag); err != nil {
		return fmt.Errorf("set ctag: %w", err)
	}
	return nil
}

// --- SyncableRepo[*domain.CalendarFeed] -----------------------------------

func (r *CalendarFeedsRepo) EntityType() string { return protocol.EntityCalendarFeed }

func (r *CalendarFeedsRepo) Dirty() ([]*domain.CalendarFeed, error) {
	rows, err := r.db.Query(`SELECT ` + feedColumns + ` FROM calendar_feeds WHERE dirty = 1 ORDER BY updated_at ASC, id ASC;`)
	if err != nil {
		return nil, fmt.Errorf("query dirty calendar feeds: %w", err)
	}
	defer rows.Close()
	out := []*domain.CalendarFeed{}
	for rows.Next() {
		f, err := scanFeed(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (r *CalendarFeedsRepo) GetAny(id string) (*domain.CalendarFeed, error) {
	rows, err := r.db.Query(`SELECT `+feedColumns+` FROM calendar_feeds WHERE id = ?;`, id)
	if err != nil {
		return nil, fmt.Errorf("query calendar feed: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanFeed(rows)
}

func (r *CalendarFeedsRepo) Apply(f *domain.CalendarFeed) error {
	// A row with no kind at all came through something that predates CalDAV — an older sync
	// server has no columns for kind/account/read-only and echoes feeds back without them, and an
	// older client re-pushes a feed the same way. Taking that at face value turned CalDAV calendars
	// into orphaned "ics" feeds, and the next rescan then created every calendar again. A current
	// writer always states the kind, so its absence means "unknown", not "ics": keep what we have.
	if f.Kind == "" {
		if local, err := r.GetAny(f.ID); err == nil && local.IsCalDAV() {
			f.Kind, f.AccountID, f.ReadOnly = local.Kind, local.AccountID, local.ReadOnly
		}
	}
	var deletedAt any
	if f.DeletedAt != nil {
		deletedAt = f.DeletedAt.UTC().Format(timeFormat)
	}
	_, err := r.db.Exec(
		`INSERT INTO calendar_feeds (id, name, kind, account_id, read_only, url, ics_text, color, created_at, updated_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   name = excluded.name, kind = excluded.kind, account_id = excluded.account_id, read_only = excluded.read_only,
		   url = excluded.url, ics_text = excluded.ics_text, color = excluded.color,
		   created_at = excluded.created_at, updated_at = excluded.updated_at,
		   deleted_at = excluded.deleted_at, version = excluded.version, dirty = 0;`,
		f.ID, f.Name, feedKind(f), f.AccountID, boolToInt(f.ReadOnly), f.URL, f.ICSText, f.Color,
		f.CreatedAt.UTC().Format(timeFormat), f.UpdatedAt.UTC().Format(timeFormat), deletedAt, f.Version,
	)
	if err != nil {
		return fmt.Errorf("apply calendar feed: %w", err)
	}
	return nil
}

func (r *CalendarFeedsRepo) MarkPushed(id string, version int64) error {
	if _, err := r.db.Exec(`UPDATE calendar_feeds SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark pushed: %w", err)
	}
	return nil
}

func (r *CalendarFeedsRepo) MeaningfulDiff(a, b *domain.CalendarFeed) bool {
	if a.Name != b.Name || a.URL != b.URL || derefStr(a.ICSText) != derefStr(b.ICSText) || derefStr(a.Color) != derefStr(b.Color) {
		return true
	}
	if feedKind(a) != feedKind(b) || derefStr(a.AccountID) != derefStr(b.AccountID) {
		return true
	}
	return (a.DeletedAt == nil) != (b.DeletedAt == nil)
}

func (r *CalendarFeedsRepo) Decode(raw json.RawMessage) (*domain.CalendarFeed, error) {
	var f domain.CalendarFeed
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, fmt.Errorf("decode calendar feed: %w", err)
	}
	return &f, nil
}

// ConflictedCopy forks a losing local feed into a fresh row so a local edit is never
// silently lost (§7.3).
func (r *CalendarFeedsRepo) ConflictedCopy(local *domain.CalendarFeed, suffix string) error {
	id, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("generate uuid: %w", err)
	}
	now := r.clock.Now().UTC()
	name := local.Name
	if name == "" {
		name = "Untitled"
	}
	_, err = r.db.Exec(
		`INSERT INTO calendar_feeds (id, name, kind, account_id, read_only, url, ics_text, color, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1);`,
		id.String(), name+" "+suffix, feedKind(local), local.AccountID, boolToInt(local.ReadOnly), local.URL, local.ICSText, local.Color,
		now.Format(timeFormat), now.Format(timeFormat),
	)
	if err != nil {
		return fmt.Errorf("insert conflicted calendar feed: %w", err)
	}
	return nil
}

// feedKind normalises the kind of a feed for storage: rows that predate CalDAV (or arrive from
// an older client) carry no kind and are ICS subscriptions.
func feedKind(f *domain.CalendarFeed) string {
	if f.Kind == "" {
		return domain.FeedKindICS
	}
	return f.Kind
}

func scanFeed(rows Rows) (*domain.CalendarFeed, error) {
	var (
		f                         domain.CalendarFeed
		accountID, icsText, color sql.NullString
		deletedAt                 sql.NullString
		createdAt, updatedAt      string
		readOnly, dirty           int
	)
	if err := rows.Scan(&f.ID, &f.Name, &f.Kind, &accountID, &readOnly, &f.URL, &icsText, &color, &createdAt, &updatedAt, &deletedAt, &f.Version, &dirty); err != nil {
		return nil, fmt.Errorf("scan calendar feed: %w", err)
	}
	if accountID.Valid {
		f.AccountID = &accountID.String
	}
	f.ReadOnly = readOnly != 0
	if icsText.Valid {
		f.ICSText = &icsText.String
	}
	if color.Valid {
		f.Color = &color.String
	}
	var err error
	if f.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if f.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	if deletedAt.Valid {
		t, err := time.Parse(timeFormat, deletedAt.String)
		if err != nil {
			return nil, fmt.Errorf("parse deleted_at: %w", err)
		}
		f.DeletedAt = &t
	}
	f.Dirty = dirty != 0
	return &f, nil
}

// ---- calendar events (server-owned, read-only on clients) ----------------

// CalendarEventsRepo holds the ICS occurrences the client expands from its feeds (PLAN §6.7,
// §E2EE). Since the client fetches feeds and pushes events (so their content can be encrypted),
// events are a normal read/write SyncableRepo: ReconcileFeedEvents writes freshly-expanded rows
// as dirty, and the sync engine pushes them. It also serves the merged Range read model consumed
// by every calendar UI.
type CalendarEventsRepo struct {
	db    Driver
	clock domain.Clock
}

const eventColumns = `id, feed_id, ics_uid, title, starts_at, ends_at, all_day, location, description, created_at, updated_at, deleted_at, version, dirty`

// ReconcileFeedEvents updates the local events of one feed to match a freshly-expanded set: new or
// changed occurrences are written dirty (so sync pushes them), and previously-stored occurrences
// that vanished from the feed are tombstoned dirty. An unchanged occurrence is left untouched, so
// a quiet feed produces no sync churn. Returns the number of rows written.
func (r *CalendarEventsRepo) ReconcileFeedEvents(feedID string, fresh []*domain.CalendarEvent) (int, error) {
	existing, err := r.liveEventsForFeed(feedID)
	if err != nil {
		return 0, err
	}
	return r.reconcile(existing, fresh)
}

// reconcile brings a set of stored occurrences in line with a freshly-expanded set.
func (r *CalendarEventsRepo) reconcile(existing map[string]*domain.CalendarEvent, fresh []*domain.CalendarEvent) (int, error) {
	now := r.clock.Now().UTC()
	written := 0
	seen := map[string]bool{}
	for _, e := range fresh {
		seen[e.ID] = true
		old, ok := existing[e.ID]
		if ok && !calendar.Changed(old, e) {
			continue // quiet occurrence: no write, no push
		}
		e.UpdatedAt = now
		if ok {
			e.CreatedAt = old.CreatedAt
			e.Version = old.Version
		} else {
			e.CreatedAt = now
			e.Version = 0
		}
		e.DeletedAt = nil
		e.Dirty = true
		if err := r.writeEvent(e); err != nil {
			return written, err
		}
		written++
	}
	// Tombstone occurrences no longer produced by the feed.
	for id, old := range existing {
		if seen[id] {
			continue
		}
		old.DeletedAt = &now
		old.UpdatedAt = now
		old.Dirty = true
		if err := r.writeEvent(old); err != nil {
			return written, err
		}
		written++
	}
	return written, nil
}

// ReconcileObjectEvents is ReconcileFeedEvents scoped to one calendar object (one UID) of a CalDAV
// feed, so editing a single event re-derives only its own occurrences instead of the whole
// calendar. Passing no fresh events tombstones every occurrence of the UID (a deleted object).
func (r *CalendarEventsRepo) ReconcileObjectEvents(feedID, uid string, fresh []*domain.CalendarEvent) (int, error) {
	rows, err := r.db.Query(`SELECT `+eventColumns+` FROM calendar_events WHERE feed_id = ? AND ics_uid = ? AND deleted_at IS NULL;`, feedID, uid)
	if err != nil {
		return 0, fmt.Errorf("query object events: %w", err)
	}
	existing := map[string]*domain.CalendarEvent{}
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			rows.Close()
			return 0, err
		}
		existing[e.ID] = e
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()
	return r.reconcile(existing, fresh)
}

// DeriveFromObject re-derives the occurrences of one CalDAV calendar object from its ICS and
// reconciles them into the store (PLAN-caldav.md §0: events stay derived). An object that is
// deleted, or waiting to be deleted, has no occurrences — so a delete disappears from the calendar
// immediately, before any device has reached the provider.
func (r *CalendarEventsRepo) DeriveFromObject(o *domain.CalendarObject) (int, error) {
	if o.DeletedAt != nil || o.PushState == domain.PushPendingDelete {
		return r.ReconcileObjectEvents(o.FeedID, o.UID, nil)
	}
	fresh, err := calendar.ExpandObject(o.ICS, o.FeedID, r.clock.Now().UTC())
	if err != nil {
		return 0, err
	}
	return r.ReconcileObjectEvents(o.FeedID, o.UID, fresh)
}

// GetLive returns one non-deleted event occurrence by id, or ErrNotFound.
func (r *CalendarEventsRepo) GetLive(id string) (*domain.CalendarEvent, error) {
	e, err := r.GetAny(id)
	if err != nil {
		return nil, err
	}
	if e.DeletedAt != nil {
		return nil, ErrNotFound
	}
	return e, nil
}

// liveEventsForFeed loads a feed's non-deleted local events keyed by id.
func (r *CalendarEventsRepo) liveEventsForFeed(feedID string) (map[string]*domain.CalendarEvent, error) {
	rows, err := r.db.Query(`SELECT `+eventColumns+` FROM calendar_events WHERE feed_id = ? AND deleted_at IS NULL;`, feedID)
	if err != nil {
		return nil, fmt.Errorf("query feed events: %w", err)
	}
	defer rows.Close()
	out := map[string]*domain.CalendarEvent{}
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out[e.ID] = e
	}
	return out, rows.Err()
}

// writeEvent upserts one event row, preserving the dirty flag carried on the struct.
func (r *CalendarEventsRepo) writeEvent(e *domain.CalendarEvent) error {
	var endsAt, location, description, deletedAt any
	if e.EndsAt != nil {
		endsAt = e.EndsAt.UTC().Format(timeFormat)
	}
	if e.Location != nil {
		location = *e.Location
	}
	if e.Description != nil {
		description = *e.Description
	}
	if e.DeletedAt != nil {
		deletedAt = e.DeletedAt.UTC().Format(timeFormat)
	}
	_, err := r.db.Exec(
		`INSERT INTO calendar_events (id, feed_id, ics_uid, title, starts_at, ends_at, all_day, location, description, created_at, updated_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   feed_id = excluded.feed_id, ics_uid = excluded.ics_uid, title = excluded.title,
		   starts_at = excluded.starts_at, ends_at = excluded.ends_at, all_day = excluded.all_day,
		   location = excluded.location, description = excluded.description,
		   updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
		   version = excluded.version, dirty = excluded.dirty;`,
		e.ID, e.FeedID, e.ICSUID, e.Title, e.StartsAt.UTC().Format(timeFormat), endsAt, boolToInt(e.AllDay),
		location, description, e.CreatedAt.UTC().Format(timeFormat), e.UpdatedAt.UTC().Format(timeFormat), deletedAt, e.Version, boolToInt(e.Dirty),
	)
	if err != nil {
		return fmt.Errorf("write calendar event: %w", err)
	}
	return nil
}

// --- SyncableRepo[*domain.CalendarEvent] ----------------------------------

func (r *CalendarEventsRepo) EntityType() string { return protocol.EntityCalendarEvent }

// Dirty returns locally-changed events (freshly expanded or tombstoned) awaiting push.
func (r *CalendarEventsRepo) Dirty() ([]*domain.CalendarEvent, error) {
	rows, err := r.db.Query(`SELECT ` + eventColumns + ` FROM calendar_events WHERE dirty = 1 ORDER BY updated_at ASC, id ASC;`)
	if err != nil {
		return nil, fmt.Errorf("query dirty calendar events: %w", err)
	}
	defer rows.Close()
	out := []*domain.CalendarEvent{}
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func (r *CalendarEventsRepo) GetAny(id string) (*domain.CalendarEvent, error) {
	rows, err := r.db.Query(`SELECT `+eventColumns+` FROM calendar_events WHERE id = ?;`, id)
	if err != nil {
		return nil, fmt.Errorf("query calendar event: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanEvent(rows)
}

// Apply overwrites the local event with a server-canonical one, clearing dirty (the incoming
// row wins). Events are derived data, so a losing local expansion is simply dropped.
func (r *CalendarEventsRepo) Apply(e *domain.CalendarEvent) error {
	e.Dirty = false
	return r.writeEvent(e)
}

// MarkPushed clears dirty and records the server version after a successful push.
func (r *CalendarEventsRepo) MarkPushed(id string, version int64) error {
	if _, err := r.db.Exec(`UPDATE calendar_events SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark pushed: %w", err)
	}
	return nil
}

// MeaningfulDiff is always false: calendar events are derived (deterministically re-expandable)
// from their feed, so a conflict never needs to preserve a losing local copy — the server row is
// adopted and the next fetch re-derives anything missing.
func (r *CalendarEventsRepo) MeaningfulDiff(a, b *domain.CalendarEvent) bool { return false }

// ConflictedCopy is a no-op: derived events are never forked into a conflicted copy.
func (r *CalendarEventsRepo) ConflictedCopy(local *domain.CalendarEvent, suffix string) error {
	return nil
}

func (r *CalendarEventsRepo) Decode(raw json.RawMessage) (*domain.CalendarEvent, error) {
	var e domain.CalendarEvent
	if err := json.Unmarshal(raw, &e); err != nil {
		return nil, fmt.Errorf("decode calendar event: %w", err)
	}
	return &e, nil
}

func scanEvent(rows Rows) (*domain.CalendarEvent, error) {
	var (
		e                              domain.CalendarEvent
		endsAt, location, description  sql.NullString
		deletedAt                      sql.NullString
		startsAt, createdAt, updatedAt string
		allDay                         int
		dirty                          int
	)
	if err := rows.Scan(&e.ID, &e.FeedID, &e.ICSUID, &e.Title, &startsAt, &endsAt, &allDay,
		&location, &description, &createdAt, &updatedAt, &deletedAt, &e.Version, &dirty); err != nil {
		return nil, fmt.Errorf("scan calendar event: %w", err)
	}
	e.Dirty = dirty != 0
	var err error
	if e.StartsAt, err = time.Parse(timeFormat, startsAt); err != nil {
		return nil, fmt.Errorf("parse starts_at: %w", err)
	}
	if endsAt.Valid {
		t, err := time.Parse(timeFormat, endsAt.String)
		if err != nil {
			return nil, fmt.Errorf("parse ends_at: %w", err)
		}
		e.EndsAt = &t
	}
	if location.Valid {
		e.Location = &location.String
	}
	if description.Valid {
		e.Description = &description.String
	}
	if e.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if e.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	if deletedAt.Valid {
		t, err := time.Parse(timeFormat, deletedAt.String)
		if err != nil {
			return nil, fmt.Errorf("parse deleted_at: %w", err)
		}
		e.DeletedAt = &t
	}
	e.AllDay = allDay != 0
	return &e, nil
}

// ---- merged calendar view (PLAN §6.7) ------------------------------------

// Range returns the merged, read-only calendar for the half-open window [from, to): feed
// events overlapping the window, tasks due within it, and daily notes dated within it,
// sorted by start. This one query is the single source of truth every client renders, so
// desktop, web, and mobile can never diverge. (Habit occurrences will join it with §16.)
//
// Timestamps are compared as RFC3339Nano UTC text — the format every writer uses — so a
// lexical comparison is a chronological one. Notes carry only a 'YYYY-MM-DD' local marker;
// they are matched against the window's date bounds.
func (r *CalendarEventsRepo) Range(from, to time.Time) ([]*domain.CalendarItem, error) {
	return r.rangeItems(from, to, "")
}

// RangeForProject is Range narrowed to one project (PLAN §6.6, "Calendars"): events from the
// calendars the project holds — each one it was given, plus every calendar of each account it
// was given — and the tasks and notes that are its members.
func (r *CalendarEventsRepo) RangeForProject(from, to time.Time, projectID string) ([]*domain.CalendarItem, error) {
	return r.rangeItems(from, to, projectID)
}

// projectFeedIDs selects the ids of the calendars a project holds, directly or through an
// account; its two parameters are both the project id. Deleted feeds are left to the caller's
// own join to filter.
const projectFeedIDs = `SELECT entity_id FROM project_members
	 WHERE project_id = ? AND entity_type = '` + domain.MemberCalendar + `' AND deleted_at IS NULL
	UNION
	SELECT af.id FROM project_members pm JOIN calendar_feeds af ON af.account_id = pm.entity_id
	 WHERE pm.project_id = ? AND pm.entity_type = '` + domain.MemberCalendarAccount + `' AND pm.deleted_at IS NULL`

// projectMemberIDs selects the ids of a project's live members of one type (project id, type).
const projectMemberIDs = `SELECT entity_id FROM project_members WHERE project_id = ? AND entity_type = ? AND deleted_at IS NULL`

// rangeItems is Range, optionally narrowed to a project ("" for everything).
func (r *CalendarEventsRepo) rangeItems(from, to time.Time, projectID string) ([]*domain.CalendarItem, error) {
	fromTS := from.UTC().Format(timeFormat)
	toTS := to.UTC().Format(timeFormat)
	fromDate := from.UTC().Format(dateLayout)
	toDate := to.UTC().Format(dateLayout)

	out := []*domain.CalendarItem{}

	// Feed events: overlap the window. A NULL ends_at is treated as an instantaneous event
	// (ends == starts). Skip events whose feed was deleted.
	eventsIn, eventArgs := "", []any{toTS, fromTS}
	if projectID != "" {
		eventsIn = ` AND e.feed_id IN (` + projectFeedIDs + `)`
		eventArgs = append(eventArgs, projectID, projectID)
	}
	rows, err := r.db.Query(
		`SELECT e.id, e.title, e.starts_at, e.ends_at, e.all_day, e.location, e.description, f.color,
		        e.feed_id, f.kind, f.read_only, o.id, COALESCE(o.recurring, 0), COALESCE(o.push_state, 'synced')
		   FROM calendar_events e
		   JOIN calendar_feeds f ON f.id = e.feed_id
		   LEFT JOIN calendar_objects o ON o.feed_id = e.feed_id AND o.uid = e.ics_uid AND o.deleted_at IS NULL
		  WHERE e.deleted_at IS NULL AND f.deleted_at IS NULL
		    AND e.starts_at < ? AND COALESCE(e.ends_at, e.starts_at) >= ?`+eventsIn+`
		  ORDER BY e.starts_at ASC;`, eventArgs...)
	if err != nil {
		return nil, fmt.Errorf("range events: %w", err)
	}
	for rows.Next() {
		var (
			id, title                     string
			startsAt                      string
			endsAt, location, desc, color sql.NullString
			allDay                        int
			feedID, kind, pushState       string
			objectID                      sql.NullString
			readOnly, recurring           int
		)
		if err := rows.Scan(&id, &title, &startsAt, &endsAt, &allDay, &location, &desc, &color,
			&feedID, &kind, &readOnly, &objectID, &recurring, &pushState); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan range event: %w", err)
		}
		item := &domain.CalendarItem{ID: "event:" + id, Kind: domain.ItemEvent, Title: title, SourceID: id, AllDay: allDay != 0, FeedID: feedID}
		// Editable only once the backing object is here: an occurrence can arrive by sync a moment
		// before its object does, and there would be nothing to patch.
		item.Editable = kind == domain.FeedKindCalDAV && readOnly == 0 && objectID.Valid
		item.Recurring = recurring != 0
		item.Pending = domain.PushState(pushState).Pending()
		if item.StartsAt, err = time.Parse(timeFormat, startsAt); err != nil {
			rows.Close()
			return nil, fmt.Errorf("parse event starts_at: %w", err)
		}
		if endsAt.Valid {
			t, err := time.Parse(timeFormat, endsAt.String)
			if err != nil {
				rows.Close()
				return nil, fmt.Errorf("parse event ends_at: %w", err)
			}
			item.EndsAt = &t
		}
		if location.Valid {
			item.Location = &location.String
		}
		if desc.Valid {
			item.Description = &desc.String
		}
		if color.Valid {
			item.Color = &color.String
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	// Tasks due within the window (not trashed/tombstoned/cancelled).
	tasksIn, taskArgs := "", []any{fromTS, toTS}
	if projectID != "" {
		tasksIn = ` AND id IN (` + projectMemberIDs + `)`
		taskArgs = append(taskArgs, projectID, domain.NodeTask)
	}
	rows, err = r.db.Query(
		`SELECT id, title, due_at FROM tasks
		  WHERE due_at IS NOT NULL AND due_at >= ? AND due_at < ?
		    AND deleted_at IS NULL AND deleting_at IS NULL AND status != 'cancelled'`+tasksIn+`
		  ORDER BY due_at ASC;`, taskArgs...)
	if err != nil {
		return nil, fmt.Errorf("range tasks: %w", err)
	}
	for rows.Next() {
		var id, title, dueAt string
		if err := rows.Scan(&id, &title, &dueAt); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan range task: %w", err)
		}
		item := &domain.CalendarItem{ID: "task:" + id, Kind: domain.ItemTask, Title: title, SourceID: id}
		if item.StartsAt, err = time.Parse(timeFormat, dueAt); err != nil {
			rows.Close()
			return nil, fmt.Errorf("parse task due_at: %w", err)
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	// Daily notes dated within the window → all-day items at local midnight.
	notesIn, noteArgs := "", []any{fromDate, toDate}
	if projectID != "" {
		notesIn = ` AND id IN (` + projectMemberIDs + `)`
		noteArgs = append(noteArgs, projectID, domain.NodeNote)
	}
	rows, err = r.db.Query(
		`SELECT id, title, date FROM notes
		  WHERE date IS NOT NULL AND date >= ? AND date < ?
		    AND deleted_at IS NULL AND deleting_at IS NULL`+notesIn+`
		  ORDER BY date ASC;`, noteArgs...)
	if err != nil {
		return nil, fmt.Errorf("range notes: %w", err)
	}
	for rows.Next() {
		var id, title, date string
		if err := rows.Scan(&id, &title, &date); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan range note: %w", err)
		}
		item := &domain.CalendarItem{ID: "note:" + id, Kind: domain.ItemNote, Title: title, SourceID: id, AllDay: true}
		if item.StartsAt, err = time.Parse(dateLayout, date); err != nil {
			rows.Close()
			return nil, fmt.Errorf("parse note date: %w", err)
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	// Global chronological order across all three kinds.
	sortItemsByStart(out)
	return out, nil
}

// sortItemsByStart orders items ascending by start instant, tie-broken by id for a stable
// result across calls.
func sortItemsByStart(items []*domain.CalendarItem) {
	sort.Slice(items, func(i, j int) bool {
		if items[i].StartsAt.Equal(items[j].StartsAt) {
			return items[i].ID < items[j].ID
		}
		return items[i].StartsAt.Before(items[j].StartsAt)
	})
}
