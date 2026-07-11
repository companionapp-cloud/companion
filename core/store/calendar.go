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

// CalendarFeedsRepo is the CRUD + sync repository for ICS feed subscriptions (PLAN §6.7).
// Feeds are ordinary user data: they sync bidirectionally. The server, not this repo,
// fetches each URL and produces the CalendarEvent clones.
type CalendarFeedsRepo struct {
	db    Driver
	clock domain.Clock
}

const feedColumns = `id, name, url, ics_text, color, created_at, updated_at, deleted_at, version, dirty`

// CreateFeedInput carries the client-supplied fields for a new feed: a name plus a source,
// either a subscription URL or the raw text of an uploaded .ics file.
type CreateFeedInput struct {
	Name    string  `json:"name"`
	URL     string  `json:"url"`
	ICSText *string `json:"icsText,omitempty"`
	Color   *string `json:"color,omitempty"`
}

// UpdateFeedInput carries partial updates; nil fields are left unchanged.
type UpdateFeedInput struct {
	Name    *string `json:"name,omitempty"`
	URL     *string `json:"url,omitempty"`
	ICSText *string `json:"icsText,omitempty"`
	Color   *string `json:"color,omitempty"`
}

// Create inserts a new feed (UUIDv7 id, version 0, dirty).
func (r *CalendarFeedsRepo) Create(in CreateFeedInput) (*domain.CalendarFeed, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return nil, fmt.Errorf("generate uuid: %w", err)
	}
	now := r.clock.Now().UTC()
	f := &domain.CalendarFeed{
		ID: id.String(), Name: in.Name, URL: in.URL, ICSText: in.ICSText, Color: in.Color,
		CreatedAt: now, UpdatedAt: now, Version: 0, Dirty: true,
	}
	if err := f.Validate(); err != nil {
		return nil, err
	}
	if _, err := r.db.Exec(
		`INSERT INTO calendar_feeds (id, name, url, ics_text, color, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
		f.ID, f.Name, f.URL, f.ICSText, f.Color,
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
	f.UpdatedAt = r.clock.Now().UTC()
	f.Dirty = true
	if err := f.Validate(); err != nil {
		return nil, err
	}
	res, err := r.db.Exec(
		`UPDATE calendar_feeds SET name = ?, url = ?, ics_text = ?, color = ?, updated_at = ?, dirty = 1
		 WHERE id = ? AND deleted_at IS NULL;`,
		f.Name, f.URL, f.ICSText, f.Color, f.UpdatedAt.Format(timeFormat), id,
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
	var deletedAt any
	if f.DeletedAt != nil {
		deletedAt = f.DeletedAt.UTC().Format(timeFormat)
	}
	_, err := r.db.Exec(
		`INSERT INTO calendar_feeds (id, name, url, ics_text, color, created_at, updated_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   name = excluded.name, url = excluded.url, ics_text = excluded.ics_text, color = excluded.color,
		   created_at = excluded.created_at, updated_at = excluded.updated_at,
		   deleted_at = excluded.deleted_at, version = excluded.version, dirty = 0;`,
		f.ID, f.Name, f.URL, f.ICSText, f.Color,
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
		`INSERT INTO calendar_feeds (id, name, url, ics_text, color, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1);`,
		id.String(), name+" "+suffix, local.URL, local.ICSText, local.Color,
		now.Format(timeFormat), now.Format(timeFormat),
	)
	if err != nil {
		return fmt.Errorf("insert conflicted calendar feed: %w", err)
	}
	return nil
}

func scanFeed(rows Rows) (*domain.CalendarFeed, error) {
	var (
		f                    domain.CalendarFeed
		icsText, color       sql.NullString
		deletedAt            sql.NullString
		createdAt, updatedAt string
		dirty                int
	)
	if err := rows.Scan(&f.ID, &f.Name, &f.URL, &icsText, &color, &createdAt, &updatedAt, &deletedAt, &f.Version, &dirty); err != nil {
		return nil, fmt.Errorf("scan calendar feed: %w", err)
	}
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
	fromTS := from.UTC().Format(timeFormat)
	toTS := to.UTC().Format(timeFormat)
	fromDate := from.UTC().Format(dateLayout)
	toDate := to.UTC().Format(dateLayout)

	out := []*domain.CalendarItem{}

	// Feed events: overlap the window. A NULL ends_at is treated as an instantaneous event
	// (ends == starts). Skip events whose feed was deleted.
	rows, err := r.db.Query(
		`SELECT e.id, e.title, e.starts_at, e.ends_at, e.all_day, e.location, e.description, f.color
		   FROM calendar_events e
		   JOIN calendar_feeds f ON f.id = e.feed_id
		  WHERE e.deleted_at IS NULL AND f.deleted_at IS NULL
		    AND e.starts_at < ? AND COALESCE(e.ends_at, e.starts_at) >= ?
		  ORDER BY e.starts_at ASC;`, toTS, fromTS)
	if err != nil {
		return nil, fmt.Errorf("range events: %w", err)
	}
	for rows.Next() {
		var (
			id, title                     string
			startsAt                      string
			endsAt, location, desc, color sql.NullString
			allDay                        int
		)
		if err := rows.Scan(&id, &title, &startsAt, &endsAt, &allDay, &location, &desc, &color); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan range event: %w", err)
		}
		item := &domain.CalendarItem{ID: "event:" + id, Kind: domain.ItemEvent, Title: title, SourceID: id, AllDay: allDay != 0}
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
	rows, err = r.db.Query(
		`SELECT id, title, due_at FROM tasks
		  WHERE due_at IS NOT NULL AND due_at >= ? AND due_at < ?
		    AND deleted_at IS NULL AND deleting_at IS NULL AND status != 'cancelled'
		  ORDER BY due_at ASC;`, fromTS, toTS)
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
	rows, err = r.db.Query(
		`SELECT id, title, date FROM notes
		  WHERE date IS NOT NULL AND date >= ? AND date < ?
		    AND deleted_at IS NULL AND deleting_at IS NULL
		  ORDER BY date ASC;`, fromDate, toDate)
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
