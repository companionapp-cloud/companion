package llm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"companion/core/calendar"
	"companion/core/domain"
	"companion/core/store"
)

// Calendar tools (PLAN §6.7, PLAN-caldav.md): read the merged calendar the Calendar screen shows,
// read one event in full, and create or change events in the calendars that can be written to.

// EventWriter creates and edits calendar events for the write tools. It is the host's event
// editing path rather than the bare store: the calendar object is patched locally, its occurrences
// re-derived and the UI told — exactly what an edit in the calendar UI does — and the change is
// then sent on to the provider (Google, iCloud…). The bridge implements it.
type EventWriter interface {
	// CreateEvent adds an event to a writable calendar and returns the id of its (first) occurrence.
	CreateEvent(feedID string, f calendar.EventFields) (string, error)
	// UpdateEvent patches the event an occurrence belongs to and returns the edited occurrence's
	// id, which changes when the event moves.
	UpdateEvent(eventID string, p calendar.EventPatch) (string, error)
}

// dayLayout is the date format the model reads and writes for all-day items.
const dayLayout = "2006-01-02"

// maxEventWindow bounds one list_events call (a year, plus slack for a DST hour).
const maxEventWindow = 367 * 24 * time.Hour

// calendarOut is a calendar as the model sees it.
type calendarOut struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Writable bool   `json:"writable"`
	// Kind is "account" (a calendar of a connected Google/iCloud/CalDAV account), "subscription"
	// (an ICS link) or "file" (an uploaded .ics).
	Kind    string `json:"kind"`
	Account string `json:"account,omitempty"`
}

// eventOut is one calendar item as the model sees it. A timed item carries local RFC3339 times;
// an all-day item carries dates, End being its last day (inclusive) — never iCalendar's exclusive
// end, which models reliably misread as one day too many.
type eventOut struct {
	ID          string     `json:"id"`
	Kind        string     `json:"kind"`
	Title       string     `json:"title"`
	Start       string     `json:"start"`
	End         string     `json:"end,omitempty"`
	AllDay      bool       `json:"allDay,omitempty"`
	Location    string     `json:"location,omitempty"`
	Description string     `json:"description,omitempty"`
	Calendar    string     `json:"calendar,omitempty"`
	CalendarID  string     `json:"calendarId,omitempty"`
	Editable    bool       `json:"editable,omitempty"`
	Recurring   bool       `json:"recurring,omitempty"`
	Repeat      *repeatOut `json:"repeat,omitempty"`
	Pending     bool       `json:"pending,omitempty"`
	Wikilink    string     `json:"wikilink,omitempty"`
}

// repeatOut is how an event repeats, with its last day as a date.
type repeatOut struct {
	Freq     string `json:"freq"`
	Interval int    `json:"interval,omitempty"`
	Until    string `json:"until,omitempty"`
	// Custom marks a rule with parts Companion can't author ("the last Friday", a count…); it
	// can be replaced with a simple rule but not tweaked.
	Custom bool `json:"custom,omitempty"`
}

// repeatArg is the model's way of saying how an event repeats.
type repeatArg struct {
	Freq     string `json:"freq"`
	Interval int    `json:"interval"`
	Until    string `json:"until"`
}

// repeatSchema is the JSON Schema of repeatArg; `none` is accepted only by update_event.
func repeatSchema(allowNone bool) string {
	freqs := `"daily","weekly","monthly","yearly"`
	if allowNone {
		freqs = `"none",` + freqs
	}
	return `{"type":"object","additionalProperties":false,"properties":{
		"freq":{"type":"string","enum":[` + freqs + `]},
		"interval":{"type":"integer","description":"Every N days/weeks/months/years (default 1)."},
		"until":{"type":"string","description":"Optional last date it may occur on (YYYY-MM-DD)."}
	},"required":["freq"]}`
}

func addCalendarTools(r *Registry, s *store.Store, events EventWriter) {
	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "list_calendars",
			Description: "List the user's calendars: each one's id, name, the account it belongs to, and whether it is `writable`. Events can only be created or changed in calendars of a connected account (Google, iCloud or another CalDAV server) that the user may edit; subscriptions and uploaded .ics files are read-only. Call this before create_event to choose a calendar, or to narrow list_events to one calendar.",
			Schema:      json.RawMessage(`{"type":"object","additionalProperties":false,"properties":{}}`),
		},
		Handler: func(_ context.Context, _ json.RawMessage) (string, error) {
			feeds, err := s.CalendarFeeds.List()
			if err != nil {
				return "", err
			}
			accounts, err := s.CalendarAccounts.List()
			if err != nil {
				return "", err
			}
			accountNames := make(map[string]string, len(accounts))
			for _, a := range accounts {
				accountNames[a.ID] = a.Name
			}
			out := make([]calendarOut, 0, len(feeds))
			for _, f := range feeds {
				c := calendarOut{ID: f.ID, Name: f.Name, Writable: f.Writable(), Kind: calendarKind(f)}
				if f.AccountID != nil {
					c.Account = accountNames[*f.AccountID]
				}
				out = append(out, c)
			}
			return jsonResult(out)
		},
	})

	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "list_events",
			Description: "List what's on the user's calendar in a time window — events from their calendars, plus tasks due and daily notes dated in that window: the same merged view as the Calendar screen. Call this whenever the user asks about their schedule, agenda, meetings, appointments or availability (\"what's on tomorrow?\", \"am I free Friday afternoon?\", \"when is my dentist appointment?\"). Call get_date first to work out the dates. `from` and `to` take a date (YYYY-MM-DD: a whole day in the user's timezone, so a date `to` includes that day) or an RFC3339 timestamp; omit `to` for a single day. To find a particular event, pass `query` and a generous window (e.g. the next three months). Timed items come back with local RFC3339 times, all-day items with dates (`end` is their last day). Pass an event's id to get_event, update_event or render_event; tasks and notes carry their wikilink.",
			Schema: json.RawMessage(`{
				"type":"object",
				"additionalProperties":false,
				"properties":{
					"from":{"type":"string","description":"Start of the window: YYYY-MM-DD or an RFC3339 timestamp."},
					"to":{"type":"string","description":"End of the window: YYYY-MM-DD (inclusive day) or an RFC3339 timestamp (exclusive). Default: one day after from."},
					"query":{"type":"string","description":"Only items whose title, location or description contains this text (case-insensitive)."},
					"calendarId":{"type":"string","description":"Only events from this calendar (from list_calendars)."},
					"kinds":{"type":"array","items":{"type":"string","enum":["event","task","note"]},"description":"Only these kinds of item. Default: all."},
					"limit":{"type":"integer","description":"Max items (default 100, max 500)."}
				},
				"required":["from"]
			}`),
		},
		Handler: func(_ context.Context, args json.RawMessage) (string, error) {
			var a struct {
				From       string   `json:"from"`
				To         string   `json:"to"`
				Query      string   `json:"query"`
				CalendarID string   `json:"calendarId"`
				Kinds      []string `json:"kinds"`
				Limit      int      `json:"limit"`
			}
			if err := json.Unmarshal(args, &a); err != nil {
				return "", err
			}
			from, to, err := eventWindow(a.From, a.To)
			if err != nil {
				return "", err
			}
			// Range matches all-day items and dated notes by their UTC date, which can sit a day
			// off the user's own; ask for a day either side and keep what really falls inside.
			items, err := s.CalendarEvents.Range(from.AddDate(0, 0, -1), to.AddDate(0, 0, 1))
			if err != nil {
				return "", err
			}
			calendars, err := calendarsByID(s)
			if err != nil {
				return "", err
			}
			kinds := map[string]bool{}
			for _, k := range a.Kinds {
				kinds[k] = true
			}
			query := strings.ToLower(strings.TrimSpace(a.Query))
			limit := a.Limit
			if limit <= 0 {
				limit = 100
			} else if limit > 500 {
				limit = 500
			}
			out := []eventOut{}
			truncated := false
			for _, it := range items {
				if !inWindow(it, from, to) ||
					(len(kinds) > 0 && !kinds[string(it.Kind)]) ||
					(a.CalendarID != "" && it.FeedID != a.CalendarID) ||
					(query != "" && !itemMatches(it, query)) {
					continue
				}
				if len(out) == limit {
					truncated = true
					break
				}
				out = append(out, itemOut(it, calendars, 500))
			}
			return jsonResult(map[string]any{
				"from":      from.Format(time.RFC3339),
				"to":        to.Format(time.RFC3339),
				"items":     out,
				"truncated": truncated,
			})
		},
	})

	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "get_event",
			Description: "Read one calendar event in full by id: its title, time, location, full description, calendar, how it repeats, and whether it can be edited here. Call this before summarizing or changing an event. Get the id from list_events.",
			Schema:      json.RawMessage(`{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string"}},"required":["id"]}`),
		},
		Handler: func(_ context.Context, args json.RawMessage) (string, error) {
			var a struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(args, &a); err != nil {
				return "", err
			}
			it, err := eventItem(s, a.ID)
			if err != nil {
				return "", err
			}
			calendars, err := calendarsByID(s)
			if err != nil {
				return "", err
			}
			out := itemOut(it, calendars, 8000)
			out.Repeat = eventRepeat(s, a.ID)
			return jsonResult(out)
		},
	})

	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "render_event",
			Description: "Show the user an inline preview card of a calendar event in the chat: its title, time, place, calendar, repeat and details. Prefer this over writing an event's details out whenever you point the user to a specific event (one you found, created or changed). The card is clickable — it opens the event in the calendar. Get the id from list_events, get_event, create_event or update_event. This does not change the event.",
			Schema:      json.RawMessage(`{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string"}},"required":["id"]}`),
		},
		Handler: func(_ context.Context, args json.RawMessage) (string, error) {
			var a struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(args, &a); err != nil {
				return "", err
			}
			it, err := eventItem(s, a.ID)
			if err != nil {
				return "", err
			}
			start, _ := whenOut(it.StartsAt, it.EndsAt, it.AllDay)
			// The chat UI draws the card from this tool call; the result only confirms it so the
			// model doesn't also write the details out.
			return fmt.Sprintf("An inline preview of the event %q (%s) is now shown to the user in the chat. Do not repeat its details — just add any commentary.", it.Title, start), nil
		},
	})

	if events == nil {
		return
	}

	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "create_event",
			Description: "Put a new event on one of the user's calendars. Call this when the user asks to schedule, book, block out or add something to their calendar (\"lunch with Sam Friday at noon\", \"block 2–4pm tomorrow for focus time\"). Call get_date first to compute real dates, and list_calendars to pick a writable calendar (calendarId may be omitted only when the user has exactly one). For a timed event give startsAt as an RFC3339 timestamp in the user's timezone, and endsAt (default: one hour later). For an all-day event set allDay and give dates (YYYY-MM-DD) — endsAt is then the LAST day, inclusive (omit it for a single day). Set `repeat` for a recurring event. This changes the user's real calendar and syncs to their calendar provider, so create only what they asked for. A to-do or a reminder is a task (create_task), not an event.",
			Schema: json.RawMessage(`{
				"type":"object",
				"additionalProperties":false,
				"properties":{
					"calendarId":{"type":"string","description":"A writable calendar's id (from list_calendars)."},
					"title":{"type":"string"},
					"startsAt":{"type":"string","description":"RFC3339 timestamp, or YYYY-MM-DD for an all-day event."},
					"endsAt":{"type":"string","description":"RFC3339 timestamp (default: an hour after startsAt), or for an all-day event its last day (YYYY-MM-DD, inclusive)."},
					"allDay":{"type":"boolean","description":"An all-day event (implied when startsAt is a date)."},
					"location":{"type":"string"},
					"description":{"type":"string","description":"Details or notes, as plain text."},
					"repeat":` + repeatSchema(false) + `
				},
				"required":["title","startsAt"]
			}`),
		},
		Write: true,
		Handler: func(_ context.Context, args json.RawMessage) (string, error) {
			var a struct {
				CalendarID  string     `json:"calendarId"`
				Title       string     `json:"title"`
				StartsAt    string     `json:"startsAt"`
				EndsAt      string     `json:"endsAt"`
				AllDay      bool       `json:"allDay"`
				Location    string     `json:"location"`
				Description string     `json:"description"`
				Repeat      *repeatArg `json:"repeat"`
			}
			if err := json.Unmarshal(args, &a); err != nil {
				return "", err
			}
			f := calendar.EventFields{Title: strings.TrimSpace(a.Title)}
			if f.Title == "" {
				return "", errors.New("title is required")
			}
			feed, err := targetCalendar(s, a.CalendarID)
			if err != nil {
				return "", err
			}
			if f.StartsAt, f.EndsAt, f.AllDay, err = newEventTimes(a.StartsAt, a.EndsAt, a.AllDay); err != nil {
				return "", err
			}
			f.Location = optText(a.Location)
			f.Description = optText(a.Description)
			if f.Repeat, err = a.Repeat.toRepeat(); err != nil {
				return "", err
			}
			if f.Repeat != nil && f.Repeat.Freq == calendar.RepeatNone {
				f.Repeat = nil
			}
			id, err := events.CreateEvent(feed.ID, f)
			if err != nil {
				return "", err
			}
			start, end := whenOut(f.StartsAt, f.EndsAt, f.AllDay)
			return jsonResult(map[string]any{
				"id": id, "title": f.Title, "calendar": feed.Name, "calendarId": feed.ID,
				"start": start, "end": end, "allDay": f.AllDay,
			})
		},
	})

	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "update_event",
			Description: "Change an existing calendar event: rename it, move or resize it (startsAt/endsAt — omit endsAt to keep its length), switch it between all-day and timed, set or clear its location or description (\"\" clears), or change how it repeats (repeat.freq \"none\" stops it repeating). Only for events whose `editable` is true in list_events / get_event, which is also where the id comes from. Omit a field to leave it unchanged; compute dates with get_date first. For a repeating event every change — times included — applies to the whole series. Returns the event as it now is; its id changes when it moves.",
			Schema: json.RawMessage(`{
				"type":"object",
				"additionalProperties":false,
				"properties":{
					"id":{"type":"string"},
					"title":{"type":"string"},
					"startsAt":{"type":"string","description":"New start: RFC3339 timestamp, or YYYY-MM-DD for an all-day event."},
					"endsAt":{"type":"string","description":"New end: RFC3339 timestamp, or an all-day event's last day (YYYY-MM-DD, inclusive)."},
					"allDay":{"type":"boolean","description":"Make it all-day (true) or timed (false; then give startsAt)."},
					"location":{"type":"string","description":"New location; \"\" removes it."},
					"description":{"type":"string","description":"New details; \"\" removes them."},
					"repeat":` + repeatSchema(true) + `
				},
				"required":["id"]
			}`),
		},
		Write: true,
		Handler: func(_ context.Context, args json.RawMessage) (string, error) {
			var a struct {
				ID          string     `json:"id"`
				Title       *string    `json:"title"`
				StartsAt    string     `json:"startsAt"`
				EndsAt      string     `json:"endsAt"`
				AllDay      *bool      `json:"allDay"`
				Location    *string    `json:"location"`
				Description *string    `json:"description"`
				Repeat      *repeatArg `json:"repeat"`
			}
			if err := json.Unmarshal(args, &a); err != nil {
				return "", err
			}
			ev, err := s.CalendarEvents.GetLive(a.ID)
			if errors.Is(err, store.ErrNotFound) {
				return "", missingEvent(a.ID)
			}
			if err != nil {
				return "", err
			}
			p := calendar.EventPatch{Location: a.Location, Description: a.Description}
			if a.Title != nil {
				t := strings.TrimSpace(*a.Title)
				if t == "" {
					return "", errors.New("title can't be empty")
				}
				p.Title = &t
			}
			if err := patchEventTimes(&p, ev, a.StartsAt, a.EndsAt, a.AllDay); err != nil {
				return "", err
			}
			if p.Repeat, err = a.Repeat.toRepeat(); err != nil {
				return "", err
			}
			if p.Title == nil && p.Location == nil && p.Description == nil && p.Repeat == nil && !patchTouchesTime(p) {
				return "", errors.New("nothing to change — pass at least one field to update")
			}
			id, err := events.UpdateEvent(ev.ID, p)
			if err != nil {
				return "", err
			}
			it, err := s.CalendarEvents.Item(id)
			if err != nil {
				return jsonResult(map[string]any{"updated": true, "note": "The event was changed, but its new id isn't known yet — call list_events to find it."})
			}
			calendars, err := calendarsByID(s)
			if err != nil {
				return "", err
			}
			out := itemOut(it, calendars, 500)
			out.Repeat = eventRepeat(s, id)
			return jsonResult(out)
		},
	})
}

// calendarKind names where a calendar comes from, for the model.
func calendarKind(f *domain.CalendarFeed) string {
	switch {
	case f.IsCalDAV():
		return "account"
	case f.ICSText != nil && strings.TrimSpace(*f.ICSText) != "":
		return "file"
	default:
		return "subscription"
	}
}

func calendarsByID(s *store.Store) (map[string]*domain.CalendarFeed, error) {
	feeds, err := s.CalendarFeeds.List()
	if err != nil {
		return nil, err
	}
	out := make(map[string]*domain.CalendarFeed, len(feeds))
	for _, f := range feeds {
		out[f.ID] = f
	}
	return out, nil
}

func missingEvent(id string) error {
	return fmt.Errorf("no event with id %q — use list_events to find it (an event's id changes when it moves)", id)
}

// eventItem loads one live event as the calendar shows it, with a model-facing miss.
func eventItem(s *store.Store, id string) (*domain.CalendarItem, error) {
	it, err := s.CalendarEvents.Item(id)
	if errors.Is(err, store.ErrNotFound) {
		return nil, missingEvent(id)
	}
	return it, err
}

// eventRepeat reads how an event repeats from its calendar object. Only calendars Companion can
// write keep objects, so a subscription's event reports nothing.
func eventRepeat(s *store.Store, eventID string) *repeatOut {
	ev, err := s.CalendarEvents.GetLive(eventID)
	if err != nil {
		return nil
	}
	o, err := s.CalendarObjects.Get(calendar.ObjectID(ev.FeedID, ev.ICSUID))
	if err != nil {
		return nil
	}
	info, err := calendar.InspectObject(o.ICS)
	if err != nil || info.Repeat == nil {
		return nil
	}
	r := &repeatOut{Freq: info.Repeat.Freq, Interval: info.Repeat.Interval, Custom: info.Repeat.Custom}
	if info.Repeat.Until != nil {
		r.Until = info.Repeat.Until.UTC().Format(dayLayout)
	}
	return r
}

// itemOut renders a merged-calendar item for the model, clipping its description to max runes.
func itemOut(it *domain.CalendarItem, calendars map[string]*domain.CalendarFeed, max int) eventOut {
	o := eventOut{
		ID: it.SourceID, Kind: string(it.Kind), Title: it.Title, AllDay: it.AllDay,
		Editable: it.Editable, Recurring: it.Recurring, Pending: it.Pending,
	}
	o.Start, o.End = whenOut(it.StartsAt, it.EndsAt, it.AllDay)
	if it.Location != nil {
		o.Location = *it.Location
	}
	if it.Description != nil {
		o.Description = clipRunes(*it.Description, max)
	}
	switch it.Kind {
	case domain.ItemEvent:
		o.CalendarID = it.FeedID
		if f := calendars[it.FeedID]; f != nil {
			o.Calendar = f.Name
		}
	case domain.ItemTask:
		o.Wikilink = fmt.Sprintf("[[%s:%s]]", domain.NodeTask, it.SourceID)
	case domain.ItemNote:
		o.Wikilink = fmt.Sprintf("[[%s:%s]]", domain.NodeNote, it.SourceID)
	}
	return o
}

// whenOut formats a span for the model: local RFC3339 instants for a timed item, dates for an
// all-day one (whose stored end is the exclusive midnight after its last day). End is empty for a
// single-day all-day item and for a point in time.
func whenOut(start time.Time, end *time.Time, allDay bool) (string, string) {
	if allDay {
		first := start.UTC().Format(dayLayout)
		if end == nil || !end.After(start) {
			return first, ""
		}
		last := end.UTC().AddDate(0, 0, -1).Format(dayLayout)
		if last <= first {
			return first, ""
		}
		return first, last
	}
	s := start.In(time.Local).Format(time.RFC3339)
	if end == nil || !end.After(start) {
		return s, ""
	}
	return s, end.In(time.Local).Format(time.RFC3339)
}

// eventWindow resolves list_events' from/to into a half-open window of instants. A date is a whole
// local day, so a date `to` includes that day; an omitted `to` means one day (or 24 hours) on.
func eventWindow(fromArg, toArg string) (time.Time, time.Time, error) {
	if strings.TrimSpace(fromArg) == "" {
		return time.Time{}, time.Time{}, errors.New("from is required: a date (YYYY-MM-DD) or an RFC3339 timestamp — call get_date for today's")
	}
	from, fromDay, err := parseWhen(fromArg, "from")
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	var to time.Time
	switch {
	case strings.TrimSpace(toArg) == "" && fromDay:
		to = from.AddDate(0, 0, 1)
	case strings.TrimSpace(toArg) == "":
		to = from.Add(24 * time.Hour)
	default:
		t, toDay, err := parseWhen(toArg, "to")
		if err != nil {
			return time.Time{}, time.Time{}, err
		}
		if toDay {
			t = t.AddDate(0, 0, 1)
		}
		to = t
	}
	if !to.After(from) {
		return time.Time{}, time.Time{}, errors.New("to must be after from")
	}
	if to.Sub(from) > maxEventWindow {
		return time.Time{}, time.Time{}, errors.New("that window is too long — ask for at most a year at a time")
	}
	return from, to, nil
}

// inWindow reports whether an item really falls in [from, to): a timed item by its instants, an
// all-day item or dated note by the local days the window covers.
func inWindow(it *domain.CalendarItem, from, to time.Time) bool {
	if it.AllDay {
		first, last := whenOut(it.StartsAt, it.EndsAt, true)
		if last == "" {
			last = first
		}
		return first <= to.Add(-time.Nanosecond).In(time.Local).Format(dayLayout) &&
			last >= from.In(time.Local).Format(dayLayout)
	}
	start, end := it.StartsAt, it.StartsAt
	if it.EndsAt != nil && it.EndsAt.After(start) {
		end = *it.EndsAt
	}
	if end.Equal(start) {
		return !start.Before(from) && start.Before(to)
	}
	return start.Before(to) && end.After(from)
}

// itemMatches reports whether an item's title, location or description contains the (lowercase)
// query.
func itemMatches(it *domain.CalendarItem, query string) bool {
	fields := []string{it.Title}
	if it.Location != nil {
		fields = append(fields, *it.Location)
	}
	if it.Description != nil {
		fields = append(fields, *it.Description)
	}
	for _, f := range fields {
		if strings.Contains(strings.ToLower(f), query) {
			return true
		}
	}
	return false
}

// parseWhen reads a time the model wrote: an RFC3339 timestamp, a local date-time without an
// offset (models often drop it), or a bare date — a local day, reported as dateOnly.
func parseWhen(s, field string) (t time.Time, dateOnly bool, err error) {
	s = strings.TrimSpace(s)
	if t, err := time.ParseInLocation(dayLayout, s, time.Local); err == nil {
		return t, true, nil
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, false, nil
	}
	for _, layout := range []string{"2006-01-02T15:04:05", "2006-01-02T15:04", "2006-01-02 15:04:05", "2006-01-02 15:04"} {
		if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
			return t, false, nil
		}
	}
	return time.Time{}, false, fmt.Errorf("%s must be an RFC3339 timestamp (like 2026-09-18T14:00:00-03:00) or a date (YYYY-MM-DD), not %q", field, s)
}

// dayMarker is the calendar date t was written for — in t's own offset, so "2026-09-18T00:00:00Z"
// is the 18th wherever the user is — as the midnight-UTC marker all-day events are stored with.
func dayMarker(t time.Time) time.Time {
	y, m, d := t.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// newEventTimes turns create_event's start/end into calendar.EventFields' shape. A timed event
// defaults to an hour; an all-day event's end is the LAST day the model named, which becomes the
// exclusive midnight after it.
func newEventTimes(startArg, endArg string, allDay bool) (time.Time, *time.Time, bool, error) {
	if strings.TrimSpace(startArg) == "" {
		return time.Time{}, nil, false, errors.New("startsAt is required")
	}
	start, startIsDay, err := parseWhen(startArg, "startsAt")
	if err != nil {
		return time.Time{}, nil, false, err
	}
	if allDay || startIsDay {
		first := dayMarker(start)
		last := first
		if strings.TrimSpace(endArg) != "" {
			end, _, err := parseWhen(endArg, "endsAt")
			if err != nil {
				return time.Time{}, nil, false, err
			}
			last = dayMarker(end)
		}
		if last.Before(first) {
			return time.Time{}, nil, false, errors.New("endsAt (the event's last day) is before startsAt")
		}
		end := last.AddDate(0, 0, 1)
		return first, &end, true, nil
	}
	end := start.Add(time.Hour)
	if strings.TrimSpace(endArg) != "" {
		e, endIsDay, err := parseWhen(endArg, "endsAt")
		if err != nil {
			return time.Time{}, nil, false, err
		}
		if endIsDay {
			return time.Time{}, nil, false, errors.New("endsAt must be a timestamp for a timed event (or set allDay for an all-day one)")
		}
		end = e
	}
	if !end.After(start) {
		return time.Time{}, nil, false, errors.New("endsAt must be after startsAt")
	}
	return start, &end, false, nil
}

// patchEventTimes fills the time part of an update from the model's arguments, read against the
// event as it is now: whether a date means an all-day day depends on what the event becomes.
// Turning a timed event all-day keeps the day the user sees it on; turning an all-day event timed
// needs a start, since a day has no time of its own.
func patchEventTimes(p *calendar.EventPatch, ev *domain.CalendarEvent, startArg, endArg string, allDayArg *bool) error {
	allDay := ev.AllDay
	if allDayArg != nil && *allDayArg != ev.AllDay {
		allDay = *allDayArg
		p.AllDay = allDayArg
	}
	hasStart, hasEnd := strings.TrimSpace(startArg) != "", strings.TrimSpace(endArg) != ""
	if allDay {
		switch {
		case hasStart:
			t, _, err := parseWhen(startArg, "startsAt")
			if err != nil {
				return err
			}
			m := dayMarker(t)
			p.StartsAt = &m
		case !ev.AllDay:
			m := dayMarker(ev.StartsAt.In(time.Local))
			p.StartsAt = &m
		}
		if hasEnd {
			t, _, err := parseWhen(endArg, "endsAt")
			if err != nil {
				return err
			}
			e := dayMarker(t).AddDate(0, 0, 1)
			p.EndsAt = &e
		}
		return nil
	}
	if ev.AllDay && !hasStart {
		return errors.New("give startsAt (and endsAt) to turn an all-day event into a timed one")
	}
	if hasStart {
		t, isDay, err := parseWhen(startArg, "startsAt")
		if err != nil {
			return err
		}
		if isDay {
			return errors.New("startsAt must be a timestamp for a timed event (or set allDay)")
		}
		p.StartsAt = &t
	}
	if hasEnd {
		t, isDay, err := parseWhen(endArg, "endsAt")
		if err != nil {
			return err
		}
		if isDay {
			return errors.New("endsAt must be a timestamp for a timed event (or set allDay)")
		}
		p.EndsAt = &t
	} else if ev.AllDay {
		// A timed event with no end is a point in time; give it the hour a new event gets.
		e := p.StartsAt.Add(time.Hour)
		p.EndsAt = &e
	}
	return nil
}

func patchTouchesTime(p calendar.EventPatch) bool {
	return p.StartsAt != nil || p.EndsAt != nil || p.AllDay != nil
}

// toRepeat converts the model's repeat argument; nil when it gave none.
func (r *repeatArg) toRepeat() (*calendar.Repeat, error) {
	if r == nil {
		return nil, nil
	}
	freq := strings.ToLower(strings.TrimSpace(r.Freq))
	switch freq {
	case calendar.RepeatNone, calendar.RepeatDaily, calendar.RepeatWeekly, calendar.RepeatMonthly, calendar.RepeatYearly:
	default:
		return nil, fmt.Errorf("repeat.freq must be daily, weekly, monthly or yearly (or none to stop repeating), not %q", r.Freq)
	}
	if r.Interval < 0 {
		return nil, errors.New("repeat.interval must be positive")
	}
	out := &calendar.Repeat{Freq: freq, Interval: r.Interval}
	if strings.TrimSpace(r.Until) != "" {
		t, _, err := parseWhen(r.Until, "repeat.until")
		if err != nil {
			return nil, err
		}
		m := dayMarker(t)
		out.Until = &m
	}
	return out, nil
}

// targetCalendar picks the calendar a new event goes in: the one asked for, or — when the model
// didn't say — the user's only writable calendar. Choosing among several is the user's call.
func targetCalendar(s *store.Store, id string) (*domain.CalendarFeed, error) {
	if id != "" {
		f, err := s.CalendarFeeds.Get(id)
		if errors.Is(err, store.ErrNotFound) {
			return nil, fmt.Errorf("no calendar with id %q — use list_calendars to find it", id)
		}
		if err != nil {
			return nil, err
		}
		if !f.Writable() {
			return nil, fmt.Errorf("the calendar %q is read-only — pick a writable one from list_calendars", f.Name)
		}
		return f, nil
	}
	feeds, err := s.CalendarFeeds.List()
	if err != nil {
		return nil, err
	}
	var writable []*domain.CalendarFeed
	for _, f := range feeds {
		if f.Writable() {
			writable = append(writable, f)
		}
	}
	switch len(writable) {
	case 1:
		return writable[0], nil
	case 0:
		return nil, errors.New("the user has no calendar Companion can add events to: only calendars of an account connected in Settings › Calendars (Google, iCloud or another CalDAV server) take new events — subscriptions and uploaded .ics files are read-only. Offer a task instead, or suggest connecting a calendar account")
	default:
		names := make([]string, 0, len(writable))
		for _, f := range writable {
			names = append(names, fmt.Sprintf("%s (%s)", f.Name, f.ID))
		}
		return nil, fmt.Errorf("several calendars can take this event — %s: pass calendarId, and ask the user which one if it isn't clear", strings.Join(names, ", "))
	}
}

// optText is nil for an empty string, so an empty field isn't written.
func optText(s string) *string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return &s
}

// clipRunes shortens s to at most max runes, marking the cut.
func clipRunes(s string, max int) string {
	r := []rune(s)
	if max <= 0 || len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}
