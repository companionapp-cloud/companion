package syncserver

import (
	"fmt"
	"net/http"
	"time"
)

// heartbeatInterval keeps idle proxies from killing the stream (PLAN §7.5).
const heartbeatInterval = 25 * time.Second

// handleEvents is the authenticated, long-lived SSE stream that pokes a device to
// sync whenever any of its user's data changes (PLAN §7.5). It writes a `change`
// event carrying the latest server_seq; the client debounces and runs a full sync
// cycle. Delivery is best-effort — the client's reconnect and periodic-timer triggers
// are the reliability backstop, so there is no replay buffer or Last-Event-ID.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r) {
		return
	}
	uid := userID(r)
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	// Disable proxy buffering (nginx honours this) so events aren't held back.
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	// Set the client reconnect backoff, then flush headers so the client's stream
	// opens immediately (it runs a sync on connect).
	fmt.Fprint(w, "retry: 5000\n\n")
	flusher.Flush()

	ch := s.hub.subscribe(uid)
	defer s.hub.unsubscribe(uid, ch)

	ping := time.NewTicker(heartbeatInterval)
	defer ping.Stop()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case seq := <-ch:
			// Coalesce any bursts already queued into a single event carrying the
			// highest seq — the client only needs the newest "sync now" poke.
			seq = drainMax(ch, seq)
			fmt.Fprintf(w, "event: change\ndata: {\"server_seq\":%d}\n\n", seq)
			flusher.Flush()
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

// drainMax returns the maximum of seq and any values already buffered on ch without
// blocking, collapsing a burst of notifications into one.
func drainMax(ch <-chan int64, seq int64) int64 {
	for {
		select {
		case next := <-ch:
			if next > seq {
				seq = next
			}
		default:
			return seq
		}
	}
}
