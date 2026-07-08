package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"sync"

	"companion/core/bridge"
)

// bridgeHandler adapts the platform-agnostic core (string method + JSON in/out +
// event stream, PLAN §3.1) onto HTTP so the Wails webview frontend can talk to it:
//
//	POST /invoke  {"method": "...", "payload": <any>}  -> the method's JSON result
//	GET  /events                                       -> Server-Sent Events stream
//
// It also implements bridge.EventHandler, fanning core events out to every
// connected SSE client (the UI's "data changed" refresh hint).
type bridgeHandler struct {
	core *bridge.Core

	mu      sync.Mutex
	clients map[chan sseMessage]struct{}
}

type sseMessage struct {
	event string
	data  []byte
}

func newBridgeHandler(core *bridge.Core) *bridgeHandler {
	return &bridgeHandler{core: core, clients: map[chan sseMessage]struct{}{}}
}

// OnEvent implements bridge.EventHandler; broadcasts to all SSE subscribers.
func (h *bridgeHandler) OnEvent(name string, payload []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.clients {
		// Non-blocking: a slow/stuck client never stalls the core.
		select {
		case ch <- sseMessage{event: name, data: payload}:
		default:
		}
	}
}

func (h *bridgeHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/invoke":
		h.handleInvoke(w, r)
	case "/events":
		h.handleEvents(w, r)
	default:
		http.NotFound(w, r)
	}
}

// invokeRequest is the wire shape for POST /invoke. Payload is kept raw so the core
// receives exactly the bytes the handler expects.
type invokeRequest struct {
	Method  string          `json:"method"`
	Payload json.RawMessage `json:"payload"`
}

func (h *bridgeHandler) handleInvoke(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// Generous cap: most invokes are tiny, but documents.ingestBytes carries a base64-encoded
	// file (PLAN §6.9), so allow room for a large attachment plus its ~33% encoding overhead.
	body, err := io.ReadAll(io.LimitReader(r.Body, 160<<20))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	var req invokeRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
		return
	}
	result, err := h.core.Invoke(req.Method, req.Payload)
	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	// result is already valid JSON from the core.
	if result == nil {
		result = []byte("null")
	}
	w.Write(result)
}

func (h *bridgeHandler) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	ch := make(chan sseMessage, 16)
	h.mu.Lock()
	h.clients[ch] = struct{}{}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.clients, ch)
		h.mu.Unlock()
	}()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher.Flush()

	bw := bufio.NewWriter(w)
	for {
		select {
		case <-r.Context().Done():
			return
		case msg := <-ch:
			data := msg.data
			if len(data) == 0 {
				data = []byte("{}")
			}
			bw.WriteString("event: ")
			bw.WriteString(msg.event)
			bw.WriteString("\ndata: ")
			bw.Write(data)
			bw.WriteString("\n\n")
			bw.Flush()
			flusher.Flush()
		}
	}
}
