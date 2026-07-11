package domain

import (
	"errors"
	"strings"
	"time"
)

// CalendarFeed is a user-authored ICS subscription (PLAN §6.7). The feed row itself is
// normal user data and syncs like any other entity; the SERVER — never the client — fetches
// its URL and clones the expanded events into CalendarEvent rows. A feed carries an optional
// color used to tint its events in the calendar UI.
type CalendarFeed struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// URL is a subscription the server re-fetches on a schedule. Empty for an uploaded feed.
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
	if !hasURL && !hasText {
		return errors.Join(ErrInvalidCalendarFeed, errors.New("a url or an uploaded .ics file is required"))
	}
	return nil
}

// SyncEntity implementation (PLAN §7).
func (f *CalendarFeed) SyncID() string           { return f.ID }
func (f *CalendarFeed) SyncVersion() int64       { return f.Version }
func (f *CalendarFeed) SyncUpdatedAt() time.Time { return f.UpdatedAt }
func (f *CalendarFeed) SyncDeleted() bool        { return f.DeletedAt != nil }
func (f *CalendarFeed) SyncDirty() bool          { return f.Dirty }

// CalendarEvent is a server-owned clone of one occurrence expanded from a feed's ICS
// (PLAN §6.7). It is READ-ONLY on clients: they receive it via the normal sync pull and
// never author or push it. Hence there is no Dirty field — SyncDirty always reports false,
// so the sync engine never treats a local event as a pending push or a conflict source.
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
}

// SyncEntity implementation (PLAN §7). SyncDirty is always false: clients never write
// calendar events, so the local copy is never a push candidate.
func (e *CalendarEvent) SyncID() string           { return e.ID }
func (e *CalendarEvent) SyncVersion() int64       { return e.Version }
func (e *CalendarEvent) SyncUpdatedAt() time.Time { return e.UpdatedAt }
func (e *CalendarEvent) SyncDeleted() bool        { return e.DeletedAt != nil }
func (e *CalendarEvent) SyncDirty() bool          { return false }

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
}
