package syncserver

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Relay (PLAN-agents.md §5.1): device-to-device request/response with streaming, for driving
// an agent hosted by a desktop from a phone or browser. The server never reads payloads — the
// clients seal them with the account master key — it only routes frames between two devices
// of the same user and remembers each request just long enough to time it out.
//
// Shape:
//   host    GET  /v1/relay/inbox            long-lived SSE; being connected = "online"
//   caller  POST /v1/relay/request          {toDeviceId, method, payload} → {requestId}
//   caller  GET  /v1/relay/response/{id}    SSE of response frames until done/error
//   host    POST /v1/relay/response/{id}    {frames:[{type, payload}]}
//   caller  POST /v1/relay/cancel/{id}      forwards a cancel frame to the host
//
// Like Hub, this is single-instance and in-memory; LISTEN/NOTIFY is the scale-out path.

// Frame types.
const (
	relayFrameRequest = "request"
	relayFrameCancel  = "cancel"
	relayFrameDelta   = "delta"
	relayFrameTool    = "tool"
	relayFrameDone    = "done"
	relayFrameError   = "error"
)

// Request statuses persisted in relay_requests.
const (
	relayStatusPending   = "pending"
	relayStatusDelivered = "delivered"
	relayStatusDone      = "done"
	relayStatusFailed    = "failed"
	relayStatusExpired   = "expired"
)

// relayRequestTTL bounds how long a request may run before the caller is told it timed out;
// relayFirstFrame bounds how long the caller waits for the host to react at all.
const (
	relayRequestTTL = 10 * time.Minute
	relayFirstFrame = 60 * time.Second
	relayIdleFrame  = 5 * time.Minute
)

// relayUnclaimedTTL bounds how long a request waits for its caller to open the response stream
// (a var so tests can shorten it). The caller opens it right after its POST returns; one that
// never does has gone away.
var relayUnclaimedTTL = time.Minute

// relayFrame is what travels on both streams. Payload is opaque (sealed by the clients).
type relayFrame struct {
	Type         string `json:"type"`
	RequestID    string `json:"requestId,omitempty"`
	FromDeviceID string `json:"fromDeviceId,omitempty"`
	Method       string `json:"method,omitempty"`
	Payload      string `json:"payload,omitempty"`
	// Error carries a server-side reason (host_offline, host_timeout) for error frames the
	// server itself generates; host-generated errors travel sealed in Payload.
	Error string `json:"error,omitempty"`
}

// relayHub holds the live inboxes (host devices) and the pending requests (caller streams).
type relayHub struct {
	mu       sync.Mutex
	inboxes  map[string]*relayInbox   // deviceID → inbox
	pending  map[string]*relayPending // requestID → caller side
	byDevice map[string]string        // deviceID → userID that opened its inbox
}

type relayInbox struct {
	userID string
	ch     chan relayFrame
}

// relayPending is one request, registered until its caller's stream has read the answer. The
// host may answer before that stream opens (a canned model list beats the caller's GET), so the
// frames wait in ch. ch is never closed: the stream ends on a terminal frame, and a close could
// race a host post still sending.
type relayPending struct {
	userID       string
	fromDeviceID string
	toDeviceID   string
	ch           chan relayFrame
	finished     bool // a terminal frame is queued; the host may add nothing more
	claimed      bool // the caller's stream has opened (only one may)
}

func newRelayHub() *relayHub {
	return &relayHub{inboxes: map[string]*relayInbox{}, pending: map[string]*relayPending{}, byDevice: map[string]string{}}
}

func (h *relayHub) online(deviceID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, ok := h.inboxes[deviceID]
	return ok
}

// attach registers an inbox for a device; a newer connection for the same device replaces the
// older one (the old stream is closed so the host reconnects on a single socket).
func (h *relayHub) attach(userID, deviceID string) *relayInbox {
	h.mu.Lock()
	defer h.mu.Unlock()
	if old := h.inboxes[deviceID]; old != nil {
		close(old.ch)
	}
	in := &relayInbox{userID: userID, ch: make(chan relayFrame, 32)}
	h.inboxes[deviceID] = in
	h.byDevice[deviceID] = userID
	return in
}

func (h *relayHub) detach(deviceID string, in *relayInbox) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if cur := h.inboxes[deviceID]; cur == in {
		delete(h.inboxes, deviceID)
		delete(h.byDevice, deviceID)
	}
}

// deliver hands a frame to a device's inbox; false when the device is offline or its buffer is
// full (a host that has stopped reading is as good as offline).
func (h *relayHub) deliver(deviceID string, f relayFrame) bool {
	h.mu.Lock()
	in := h.inboxes[deviceID]
	h.mu.Unlock()
	if in == nil {
		return false
	}
	select {
	case in.ch <- f:
		return true
	default:
		return false
	}
}

// addPending registers a request. One whose caller never opens the response stream is forgotten
// after relayUnclaimedTTL.
func (h *relayHub) addPending(id string, p *relayPending) {
	h.mu.Lock()
	h.pending[id] = p
	h.mu.Unlock()
	time.AfterFunc(relayUnclaimedTTL, func() {
		h.mu.Lock()
		if h.pending[id] == p && !p.claimed {
			delete(h.pending, id)
		}
		h.mu.Unlock()
	})
}

// getPending returns a request the host is still answering: nil when unknown or finished.
func (h *relayHub) getPending(id string) *relayPending {
	h.mu.Lock()
	defer h.mu.Unlock()
	if p := h.pending[id]; p != nil && !p.finished {
		return p
	}
	return nil
}

// claim hands a request to its caller's response stream, finished or not; nil when it is
// unknown, another user's, or already streaming.
func (h *relayHub) claim(id, userID string) *relayPending {
	h.mu.Lock()
	defer h.mu.Unlock()
	p := h.pending[id]
	if p == nil || p.userID != userID || p.claimed {
		return nil
	}
	p.claimed = true
	return p
}

// respond queues a response frame for the caller; false when the request is unknown/finished.
func (h *relayHub) respond(id string, f relayFrame) bool {
	h.mu.Lock()
	p := h.pending[id]
	if p == nil || p.finished {
		h.mu.Unlock()
		return false
	}
	if f.Type == relayFrameDone || f.Type == relayFrameError {
		p.finished = true
	}
	h.mu.Unlock()
	// Blocking send with a bound: a caller that stopped reading shouldn't stall the host.
	select {
	case p.ch <- f:
		return true
	case <-time.After(5 * time.Second):
		return false
	}
}

// forget removes a request once its stream has ended (or it could not be delivered).
func (h *relayHub) forget(id string) {
	h.mu.Lock()
	delete(h.pending, id)
	h.mu.Unlock()
}

// --- handlers ---------------------------------------------------------------

// handleRelayInbox is the host's long-lived stream. The device id comes from the request header;
// the device must belong to the caller. Connecting marks the device online.
func (s *Server) handleRelayInbox(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r) {
		return
	}
	uid := userID(r)
	deviceID := strings.TrimSpace(r.Header.Get(deviceHeader))
	if deviceID == "" {
		deviceID = strings.TrimSpace(r.URL.Query().Get("device"))
	}
	if deviceID == "" {
		writeErr(w, http.StatusBadRequest, "device id required")
		return
	}
	owned, err := s.deviceOwnedBy(uid, deviceID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "device lookup failed")
		return
	}
	if !owned {
		writeErr(w, http.StatusForbidden, "unknown device; register it first")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	sseHeaders(w)
	fmt.Fprint(w, "retry: 5000\n\n")
	flusher.Flush()

	in := s.relay.attach(uid, deviceID)
	defer s.relay.detach(deviceID, in)
	s.touchDevice(uid, r)

	ping := time.NewTicker(heartbeatInterval)
	defer ping.Stop()
	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case f, ok := <-in.ch:
			if !ok {
				return // replaced by a newer connection
			}
			writeSSE(w, f.Type, f)
			flusher.Flush()
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

// handleRelayRequest enqueues a request for another of the caller's devices.
func (s *Server) handleRelayRequest(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r) {
		return
	}
	uid := userID(r)
	var in struct {
		ToDeviceID string `json:"toDeviceId"`
		Method     string `json:"method"`
		Payload    string `json:"payload"`
	}
	if err := decode(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	from := strings.TrimSpace(r.Header.Get(deviceHeader))
	if from == "" || in.ToDeviceID == "" || in.Method == "" {
		writeErr(w, http.StatusBadRequest, "from device (header), toDeviceId and method are required")
		return
	}
	if len(in.Payload) > 1<<20 {
		writeErr(w, http.StatusRequestEntityTooLarge, "payload too large")
		return
	}
	owned, err := s.deviceOwnedBy(uid, in.ToDeviceID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "device lookup failed")
		return
	}
	if !owned {
		writeErr(w, http.StatusForbidden, "target device is not on this account")
		return
	}
	if !s.relay.online(in.ToDeviceID) {
		writeErr(w, http.StatusConflict, "host_offline")
		return
	}
	id := uuid.NewString()
	now := s.clock.Now().UTC()
	if _, err := s.exec(
		`INSERT INTO relay_requests (id, user_id, from_device_id, to_device_id, method, status, created_at, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
		id, uid, from, in.ToDeviceID, in.Method, relayStatusPending, now.Format(timeFormat), now.Add(relayRequestTTL).Format(timeFormat)); err != nil {
		writeErr(w, http.StatusInternalServerError, "relay store failed")
		return
	}
	s.relay.addPending(id, &relayPending{userID: uid, fromDeviceID: from, toDeviceID: in.ToDeviceID, ch: make(chan relayFrame, 64)})
	if !s.relay.deliver(in.ToDeviceID, relayFrame{Type: relayFrameRequest, RequestID: id, FromDeviceID: from, Method: in.Method, Payload: in.Payload}) {
		s.relay.forget(id)
		s.setRelayStatus(id, relayStatusFailed)
		writeErr(w, http.StatusConflict, "host_offline")
		return
	}
	s.setRelayStatus(id, relayStatusDelivered)
	writeJSON(w, http.StatusOK, map[string]string{"requestId": id})
}

// handleRelayResponseStream is the caller's stream of response frames for one request.
func (s *Server) handleRelayResponseStream(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r) {
		return
	}
	uid := userID(r)
	id := r.PathValue("id")
	// Claim, not getPending: the host may already have answered, and its frames wait for us.
	p := s.relay.claim(id, uid)
	if p == nil {
		writeErr(w, http.StatusNotFound, "unknown request")
		return
	}
	defer s.relay.forget(id)
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	sseHeaders(w)
	flusher.Flush()

	ctx := r.Context()
	timeout := time.NewTimer(relayFirstFrame)
	defer timeout.Stop()
	ping := time.NewTicker(heartbeatInterval)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			// Caller went away: tell the host to stop.
			s.relay.deliver(p.toDeviceID, relayFrame{Type: relayFrameCancel, RequestID: id})
			return
		case f := <-p.ch:
			writeSSE(w, f.Type, f)
			flusher.Flush()
			if f.Type == relayFrameDone || f.Type == relayFrameError {
				status := relayStatusDone
				if f.Type == relayFrameError {
					status = relayStatusFailed
				}
				s.setRelayStatus(id, status)
				return
			}
			timeout.Reset(relayIdleFrame)
		case <-timeout.C:
			writeSSE(w, relayFrameError, relayFrame{Type: relayFrameError, RequestID: id, Error: "host_timeout"})
			flusher.Flush()
			s.relay.deliver(p.toDeviceID, relayFrame{Type: relayFrameCancel, RequestID: id})
			s.setRelayStatus(id, relayStatusExpired)
			return
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

// handleRelayResponsePost lets the host push frames for a request it is serving.
func (s *Server) handleRelayResponsePost(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r) {
		return
	}
	uid := userID(r)
	id := r.PathValue("id")
	p := s.relay.getPending(id)
	if p == nil || p.userID != uid {
		writeErr(w, http.StatusNotFound, "unknown or finished request")
		return
	}
	from := strings.TrimSpace(r.Header.Get(deviceHeader))
	if from != p.toDeviceID {
		writeErr(w, http.StatusForbidden, "only the host may respond")
		return
	}
	var in struct {
		Frames []relayFrame `json:"frames"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
	if err := decode(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	for _, f := range in.Frames {
		switch f.Type {
		case relayFrameDelta, relayFrameTool, relayFrameDone, relayFrameError:
		default:
			writeErr(w, http.StatusBadRequest, "bad frame type "+f.Type)
			return
		}
		f.RequestID = id
		if !s.relay.respond(id, f) {
			break
		}
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleRelayCancel forwards a caller's cancel to the host.
func (s *Server) handleRelayCancel(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r) {
		return
	}
	uid := userID(r)
	id := r.PathValue("id")
	p := s.relay.getPending(id)
	if p == nil || p.userID != uid {
		writeErr(w, http.StatusNotFound, "unknown request")
		return
	}
	s.relay.deliver(p.toDeviceID, relayFrame{Type: relayFrameCancel, RequestID: id})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) setRelayStatus(id, status string) {
	_, _ = s.exec(`UPDATE relay_requests SET status = ? WHERE id = ?;`, status, id)
}

// ExpireRelayRequests marks stale relay rows expired and deletes very old ones. Cheap enough
// to run from the trash collector's tick.
func (s *Server) ExpireRelayRequests(ctx context.Context) error {
	now := s.clock.Now().UTC()
	if _, err := s.exec(`UPDATE relay_requests SET status = ? WHERE status IN (?, ?) AND expires_at < ?;`,
		relayStatusExpired, relayStatusPending, relayStatusDelivered, now.Format(timeFormat)); err != nil {
		return err
	}
	_, err := s.exec(`DELETE FROM relay_requests WHERE created_at < ?;`, now.Add(-24*time.Hour).Format(timeFormat))
	return err
}

func sseHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
}

func writeSSE(w http.ResponseWriter, event string, v any) {
	b, _ := json.Marshal(v)
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b)
}
