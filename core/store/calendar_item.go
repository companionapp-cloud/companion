package store

import (
	"time"

	"companion/core/domain"
)

// Item is one live event as Range presents it — colored by its calendar, and flagged editable,
// recurring or pending — looked up by its occurrence id. It asks Range for the instant the event
// starts rather than repeating Range's query, so a single event (a chat preview, an assistant's
// answer) can never disagree with the calendar it sits in. ErrNotFound when the event, or the
// calendar it came from, is gone.
func (r *CalendarEventsRepo) Item(id string) (*domain.CalendarItem, error) {
	ev, err := r.GetLive(id)
	if err != nil {
		return nil, err
	}
	items, err := r.Range(ev.StartsAt, ev.StartsAt.Add(time.Second))
	if err != nil {
		return nil, err
	}
	for _, it := range items {
		if it.Kind == domain.ItemEvent && it.SourceID == id {
			return it, nil
		}
	}
	return nil, ErrNotFound
}
