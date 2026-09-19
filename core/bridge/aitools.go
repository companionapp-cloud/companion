package bridge

import (
	"log"
	"time"

	"companion/core/calendar"
	"companion/core/llm"
)

// The assistant's tools (PLAN §6.8). Every agent gets the same set: the built-in engine directly,
// a CLI agent over MCP (mcp.go). Most tools only need the store; calendar writes take the calendar
// UI's own path (eventWriter) so an event the assistant makes is indistinguishable from one the
// user made.

// toolRegistry builds the registry every agent works with.
func (c *Core) toolRegistry() *llm.Registry {
	return llm.NewStoreRegistry(c.store, llm.WithEventWriter(eventWriter{c}))
}

// eventWriter lets the calendar tools create and edit events exactly as the calendar UI does
// (calendar_events.go), then sends the change on to the provider without waiting for the next
// refresh — the UI pushes after its own edits for the same reason (CalendarProvider).
type eventWriter struct{ c *Core }

func (w eventWriter) CreateEvent(feedID string, f calendar.EventFields) (string, error) {
	id, err := w.c.createEvent(feedID, f)
	if err == nil {
		w.c.pushCalendarSoon()
	}
	return id, err
}

func (w eventWriter) UpdateEvent(eventID string, p calendar.EventPatch) (string, error) {
	id, err := w.c.updateEvent(eventID, p)
	if err == nil {
		w.c.pushCalendarSoon()
	}
	return id, err
}

// calendarPushDelay is how long pushCalendarSoon waits for more edits before pushing.
var calendarPushDelay = 2 * time.Second

// pushCalendarSoon sends pending calendar changes on their way shortly, off the caller's path: the
// assistant's turn doesn't wait on the provider, and several edits in one turn go out in one push.
// A failed push isn't the assistant's error — the change stays pending for the next attempt.
func (c *Core) pushCalendarSoon() {
	c.calPushMu.Lock()
	defer c.calPushMu.Unlock()
	if c.calPushTimer != nil {
		c.calPushTimer.Stop()
	}
	c.calPushTimer = time.AfterFunc(calendarPushDelay, func() {
		if _, err := c.calendarPush(); err != nil {
			log.Printf("calendar: push after assistant edit: %v", err)
		}
	})
}
