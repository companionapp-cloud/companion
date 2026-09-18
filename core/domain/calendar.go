package domain

import (
	"errors"
	"strings"
	"time"
)

// Feed kinds. An ICS feed is a read-only subscription (or an uploaded file); a CalDAV feed is one
// calendar collection of a CalendarAccount and can be written back to (PLAN-caldav.md).
const (
	FeedKindICS    = "ics"
	FeedKindCalDAV = "caldav"
)

// CalendarFeed is one calendar (PLAN §6.7): an ICS subscription, an uploaded .ics file, or a
// CalDAV collection. The row is normal user data and syncs like any other entity; the CLIENT
// fetches it and derives the CalendarEvent rows (PLAN §E2EE). A feed carries an optional color
// used to tint its events in the calendar UI.
type CalendarFeed struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Kind is FeedKindICS or FeedKindCalDAV. Empty means ICS (rows written before CalDAV existed).
	Kind string `json:"kind,omitempty"`
	// AccountID is the owning CalendarAccount of a CalDAV feed; nil for ICS feeds.
	AccountID *string `json:"accountId,omitempty"`
	// ReadOnly marks a CalDAV calendar the login may not write to (a shared or holiday calendar).
	ReadOnly bool `json:"readOnly,omitempty"`
	// URL is the subscription URL of an ICS feed, or the collection URL of a CalDAV feed. Empty
	// for an uploaded feed.
	URL string `json:"url"`
	// ICSText is the raw contents of an uploaded .ics file. When set, the server parses it
	// in place (no HTTP fetch) — the file's events sync to every device like a URL feed's do.
	// Exactly one of URL / ICSText is non-empty.
	ICSText   *string    `json:"icsText,omitempty"`
	Color     *string    `json:"color,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt time.Time  `json:"updatedAt"`
	DeletedAt *time.Time `json:"deletedAt,omitempty"`
	Version   int64      `json:"version"`
	Dirty     bool       `json:"dirty"`
}

// ErrInvalidCalendarFeed is returned when a feed fails validation.
var ErrInvalidCalendarFeed = errors.New("invalid calendar feed")

// Validate checks the invariants that must hold before a feed is persisted: a name plus a
// source — either a subscription URL or uploaded ICS text.
func (f *CalendarFeed) Validate() error {
	if strings.TrimSpace(f.ID) == "" {
		return errors.Join(ErrInvalidCalendarFeed, errors.New("id is required"))
	}
	if strings.TrimSpace(f.Name) == "" {
		return errors.Join(ErrInvalidCalendarFeed, errors.New("name is required"))
	}
	hasURL := strings.TrimSpace(f.URL) != ""
	hasText := f.ICSText != nil && strings.TrimSpace(*f.ICSText) != ""
	if f.IsCalDAV() {
		if !hasURL {
			return errors.Join(ErrInvalidCalendarFeed, errors.New("a caldav calendar needs its collection url"))
		}
		if f.AccountID == nil || strings.TrimSpace(*f.AccountID) == "" {
			return errors.Join(ErrInvalidCalendarFeed, errors.New("a caldav calendar needs an account"))
		}
		return nil
	}
	if f.Kind != "" && f.Kind != FeedKindICS {
		return errors.Join(ErrInvalidCalendarFeed, errors.New("unknown calendar kind "+f.Kind))
	}
	if !hasURL && !hasText {
		return errors.Join(ErrInvalidCalendarFeed, errors.New("a url or an uploaded .ics file is required"))
	}
	return nil
}

// IsCalDAV reports whether the feed is a CalDAV collection (as opposed to an ICS subscription).
func (f *CalendarFeed) IsCalDAV() bool { return f.Kind == FeedKindCalDAV }

// Writable reports whether events may be created or edited in this feed.
func (f *CalendarFeed) Writable() bool { return f.IsCalDAV() && !f.ReadOnly }

// SyncEntity implementation (PLAN §7).
func (f *CalendarFeed) SyncID() string           { return f.ID }
func (f *CalendarFeed) SyncVersion() int64       { return f.Version }
func (f *CalendarFeed) SyncUpdatedAt() time.Time { return f.UpdatedAt }
func (f *CalendarFeed) SyncDeleted() bool        { return f.DeletedAt != nil }
func (f *CalendarFeed) SyncDirty() bool          { return f.Dirty }

// CalendarEvent is one occurrence expanded from a feed's ICS (PLAN §6.7). Under end-to-end
// encryption the CLIENT — not the server — fetches each feed, expands it, and pushes the events,
// so their content (title/location/description) is encrypted before it leaves the device. Events
// are therefore ordinary syncable rows: dirty-tracked and pushed like any entity. Their ids are
// deterministic (feed|uid|start), so every device expanding the same feed produces the same rows
// and they converge instead of duplicating.
type CalendarEvent struct {
	ID          string     `json:"id"`
	FeedID      string     `json:"feedId"`
	ICSUID      string     `json:"icsUid"`
	Title       string     `json:"title"`
	StartsAt    time.Time  `json:"startsAt"`
	EndsAt      *time.Time `json:"endsAt,omitempty"`
	AllDay      bool       `json:"allDay"`
	Location    *string    `json:"location,omitempty"`
	Description *string    `json:"description,omitempty"`
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
	DeletedAt   *time.Time `json:"deletedAt,omitempty"`
	Version     int64      `json:"version"`
	Dirty       bool       `json:"dirty"`
}

// SyncEntity implementation (PLAN §7).
func (e *CalendarEvent) SyncID() string           { return e.ID }
func (e *CalendarEvent) SyncVersion() int64       { return e.Version }
func (e *CalendarEvent) SyncUpdatedAt() time.Time { return e.UpdatedAt }
func (e *CalendarEvent) SyncDeleted() bool        { return e.DeletedAt != nil }
func (e *CalendarEvent) SyncDirty() bool          { return e.Dirty }

// ItemKind tags the origin of a CalendarItem in the merged calendar view.
type ItemKind string

const (
	// ItemEvent is a cloned occurrence from an ICS feed.
	ItemEvent ItemKind = "event"
	// ItemTask is a task surfaced on its due date.
	ItemTask ItemKind = "task"
	// ItemNote is a daily note surfaced on its date (all-day).
	ItemNote ItemKind = "note"
)

// CalendarItem is one entry in the merged, read-only calendar view produced by
// store.CalendarEventsRepo.Range (PLAN §6.7). It unifies feed events, due tasks, and dated
// notes into a single timeline so every client renders the same calendar from one query.
// Habit occurrences will join this model when habits (milestone 16) land.
type CalendarItem struct {
	// ID is unique within a range result: the underlying row id, prefixed by kind so an
	// event and a task can never collide.
	ID       string     `json:"id"`
	Kind     ItemKind   `json:"kind"`
	Title    string     `json:"title"`
	StartsAt time.Time  `json:"startsAt"`
	EndsAt   *time.Time `json:"endsAt,omitempty"`
	AllDay   bool       `json:"allDay"`
	// SourceID is the id of the backing row (event/task/note) so the UI can open it.
	SourceID string `json:"sourceId"`
	// Location and Description carry an event's extra detail (shown on hover / in the mobile
	// detail view); nil for tasks and notes.
	Location    *string `json:"location,omitempty"`
	Description *string `json:"description,omitempty"`
	// Color is the feed color for events; nil for tasks and notes (they use kind palettes).
	Color *string `json:"color,omitempty"`
	// FeedID is the calendar an event belongs to; empty for tasks and notes.
	FeedID string `json:"feedId,omitempty"`
	// Editable is true for an event in a writable CalDAV calendar (PLAN-caldav.md). ICS
	// subscriptions, read-only calendars, tasks and notes are never editable from the calendar.
	Editable bool `json:"editable,omitempty"`
	// Recurring marks an occurrence of a repeating event, so the UI can ask "this one or all?".
	Recurring bool `json:"recurring,omitempty"`
	// Pending is true while a local change has not reached the provider yet.
	Pending bool `json:"pending,omitempty"`
}
