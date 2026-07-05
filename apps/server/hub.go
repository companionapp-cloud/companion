package main

import "sync"

// Hub is the in-process per-user fan-out for realtime change notifications (PLAN
// §7.5). After any transaction that bumps a user's server_seq commits, the writer
// publishes that seq; every SSE connection for that user forwards it as a `change`
// event. Delivery is fire-and-forget: a lagging subscriber's notification is dropped
// rather than blocking the writer, because every reconnect and the client's periodic
// timer trigger a full sync anyway — the event is only a "sync now" poke.
//
// v1 is single-instance. The scale-out path is Postgres LISTEN/NOTIFY fanning out to
// each instance's hub (documented in PLAN §7.5, not built).
type Hub struct {
	mu   sync.Mutex
	subs map[string]map[chan int64]struct{} // userID -> set of subscriber channels
}

func NewHub() *Hub {
	return &Hub{subs: make(map[string]map[chan int64]struct{})}
}

// subscribe registers a buffered channel for a user and returns it. The caller must
// unsubscribe when the connection ends.
func (h *Hub) subscribe(userID string) chan int64 {
	ch := make(chan int64, 8) // buffered: publish never blocks (drops on full)
	h.mu.Lock()
	defer h.mu.Unlock()
	set := h.subs[userID]
	if set == nil {
		set = make(map[chan int64]struct{})
		h.subs[userID] = set
	}
	set[ch] = struct{}{}
	return ch
}

func (h *Hub) unsubscribe(userID string, ch chan int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if set := h.subs[userID]; set != nil {
		delete(set, ch)
		if len(set) == 0 {
			delete(h.subs, userID)
		}
	}
	close(ch)
}

// publish notifies all of a user's subscribers of the latest server_seq. A
// non-blocking send drops the notification for any subscriber whose buffer is full;
// that client catches up on its next event or timer-driven sync.
func (h *Hub) publish(userID string, seq int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs[userID] {
		select {
		case ch <- seq:
		default:
		}
	}
}
