package bridge

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	cryptopkg "companion/core/crypto"
	"companion/core/domain"
	"companion/core/store"
)

// Relay (PLAN-agents.md §5): driving an agent hosted by another device through the sync
// server. Both roles live here. The caller side (any device) posts a sealed request and
// streams the host's sealed response frames, re-emitting them as the ordinary llm.* events so
// ChatView is none the wiser. The host side (a desktop that can host) keeps an SSE inbox open
// whenever sync is configured, runs each request against its own core, and persists the
// transcript — which reaches the caller through normal sync.

// Relay frame types (mirror packages/syncserver/relay.go).
const (
	relayDelta = "delta"
	relayTool  = "tool"
	relayDone  = "done"
	relayError = "error"
)

// Methods a host will run for a remote caller. Everything else is refused before Invoke.
var relayAllowedMethods = map[string]bool{"chats.send": true, "chats.cancel": true, "agents.models": true}

// relayClient is the per-process relay state for the configured sync account.
type relayClient struct {
	mu       sync.Mutex
	baseURL  string
	token    string
	deviceID string
	http     *http.Client
	// inflight maps chat id → cancel for remote turns this device started (caller role).
	inflight map[string]context.CancelFunc
	// hosting maps relay request id → cancel for turns this device is running (host role);
	// hostChats maps request id → chat id so a cancel frame can stop the local run.
	hosting   map[string]context.CancelFunc
	hostChats map[string]string
	// hostCancel stops the inbox loop; nil when not hosting.
	hostCancel context.CancelFunc
}

func newRelayClient(baseURL, token, deviceID string) *relayClient {
	return &relayClient{
		baseURL: strings.TrimRight(baseURL, "/"), token: token, deviceID: deviceID,
		http:     &http.Client{Timeout: 30 * time.Second},
		inflight: map[string]context.CancelFunc{}, hosting: map[string]context.CancelFunc{}, hostChats: map[string]string{},
	}
}

func (r *relayClient) creds() (baseURL, token string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.baseURL, r.token
}

func (r *relayClient) setCreds(baseURL, token string) {
	r.mu.Lock()
	r.baseURL, r.token = strings.TrimRight(baseURL, "/"), token
	r.mu.Unlock()
}

// cancelRemote aborts a remote turn started from this device; reports whether there was one.
func (r *relayClient) cancelRemote(chatID string) bool {
	if r == nil {
		return false
	}
	r.mu.Lock()
	cancel, ok := r.inflight[chatID]
	r.mu.Unlock()
	if ok && cancel != nil {
		cancel()
	}
	return ok
}

// errHostOffline is returned when the hosting desktop has no live relay connection.
var errHostOffline = errors.New("host_offline")

// --- sealing -----------------------------------------------------------------

// seal encrypts a relay payload under the account master key. On a plaintext (legacy) account
// the JSON travels as-is; the server still only ever routes it.
func (c *Core) seal(v any) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	if mk := c.getMasterKey(); mk != nil {
		if cipher := cryptopkg.NewCipher(mk); cipher != nil {
			return cipher.SealBlob(b)
		}
	}
	return string(b), nil
}

// open reverses seal, tolerating plaintext payloads from legacy accounts.
func (c *Core) open(payload string, v any) error {
	if cryptopkg.IsEnvelope(payload) {
		mk := c.getMasterKey()
		if mk == nil {
			return errors.New("relay payload is encrypted but this device is locked")
		}
		cipher := cryptopkg.NewCipher(mk)
		if cipher == nil {
			return errors.New("bad master key")
		}
		b, err := cipher.OpenBlob(payload)
		if err != nil {
			return err
		}
		return json.Unmarshal(b, v)
	}
	return json.Unmarshal([]byte(payload), v)
}

// --- HTTP helpers ---------------------------------------------------------------

func (r *relayClient) newRequest(ctx context.Context, method, path string, body any) (*http.Request, error) {
	base, token := r.creds()
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, base+path, reader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Companion-Device", r.deviceID)
	return req, nil
}

// postJSON posts body and decodes the JSON reply into out (may be nil).
func (r *relayClient) postJSON(ctx context.Context, path string, body, out any) error {
	req, err := r.newRequest(ctx, http.MethodPost, path, body)
	if err != nil {
		return err
	}
	res, err := r.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		return relayHTTPError(res)
	}
	if out != nil {
		return json.NewDecoder(res.Body).Decode(out)
	}
	return nil
}

func (r *relayClient) getJSON(ctx context.Context, path string, out any) error {
	req, err := r.newRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return err
	}
	res, err := r.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		return relayHTTPError(res)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

// relayHTTPError turns a non-2xx reply into an error carrying the server's message; a 409
// host_offline is mapped to errHostOffline so callers can special-case it.
func relayHTTPError(res *http.Response) error {
	var body struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(io.LimitReader(res.Body, 4096)).Decode(&body)
	if body.Error == "host_offline" || res.StatusCode == http.StatusConflict {
		return errHostOffline
	}
	if body.Error == "" {
		body.Error = res.Status
	}
	return errors.New(body.Error)
}

// openSSE opens a streaming GET and returns the response; the caller reads frames with readSSE.
func (r *relayClient) openSSE(ctx context.Context, path string) (*http.Response, error) {
	req, err := r.newRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "text/event-stream")
	// Streams are long-lived: no client timeout (ctx governs their life).
	res, err := (&http.Client{}).Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		defer res.Body.Close()
		return nil, relayHTTPError(res)
	}
	return res, nil
}

// wireFrame is a relay frame as the server writes it.
type wireFrame struct {
	Type         string `json:"type"`
	RequestID    string `json:"requestId"`
	FromDeviceID string `json:"fromDeviceId"`
	Method       string `json:"method"`
	Payload      string `json:"payload"`
	Error        string `json:"error"`
}

// readSSE parses text/event-stream frames from body and calls fn for each data-bearing one
// until EOF, a read error, or fn returning false.
func readSSE(body io.Reader, fn func(event string, data []byte) bool) error {
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 0, 64<<10), 8<<20)
	event := ""
	var data bytes.Buffer
	flush := func() bool {
		if data.Len() == 0 {
			event = ""
			return true
		}
		ok := fn(event, bytes.TrimSuffix(data.Bytes(), []byte("\n")))
		event = ""
		data.Reset()
		return ok
	}
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
			if !flush() {
				return nil
			}
		case strings.HasPrefix(line, ":"):
			// comment / ping
		case strings.HasPrefix(line, "event:"):
			event = strings.TrimSpace(line[len("event:"):])
		case strings.HasPrefix(line, "data:"):
			data.WriteString(strings.TrimPrefix(strings.TrimSpace(line[len("data:"):]), " "))
			data.WriteByte('\n')
		}
	}
	flush()
	return sc.Err()
}

// --- device registration + presence --------------------------------------------

// registerDevice upserts this device on the server. The name is sealed like a row field on an
// E2EE account so the server never learns "Chris's MacBook".
func (c *Core) registerDevice(ctx context.Context) error {
	if c.relay == nil {
		return nil
	}
	info, err := c.store.DeviceInfo()
	if err != nil {
		return err
	}
	name := c.deviceDisplayName(info)
	if mk := c.getMasterKey(); mk != nil {
		if env, err := cryptopkg.EncryptField(mk, "device", "name", mustJSONBytes(name)); err == nil {
			name = env
		}
	}
	body := map[string]any{"id": info.ID, "name": name, "platform": info.Platform, "canHost": c.device.canHost}
	return c.relay.postJSON(ctx, "/v1/devices", body, nil)
}

func mustJSONBytes(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// refreshPresence pulls the account's device list and updates the local presence table.
func (c *Core) refreshPresence(ctx context.Context) error {
	if c.relay == nil {
		return nil
	}
	var list []struct {
		ID         string    `json:"id"`
		Name       string    `json:"name"`
		Platform   string    `json:"platform"`
		CanHost    bool      `json:"canHost"`
		Online     bool      `json:"online"`
		LastSeenAt time.Time `json:"lastSeenAt"`
	}
	if err := c.relay.getJSON(ctx, "/v1/devices", &list); err != nil {
		return err
	}
	me, _ := c.store.EnsureDeviceID()
	mk := c.getMasterKey()
	for _, d := range list {
		if d.ID == me {
			continue
		}
		name := d.Name
		if cryptopkg.IsEnvelope(name) && mk != nil {
			if plain, err := cryptopkg.DecryptField(mk, "device", "name", name); err == nil {
				var s string
				if json.Unmarshal(plain, &s) == nil {
					name = s
				}
			}
		} else if cryptopkg.IsEnvelope(name) {
			name = d.Platform
		}
		c.setPresence(d.ID, presenceEntry{online: d.Online, lastSeenAt: d.LastSeenAt, name: name, platform: d.Platform, canHost: d.CanHost})
	}
	return nil
}

// --- caller role ------------------------------------------------------------------

// sendRemote hands a user turn to the agent's host through the relay. The host runs it, streams
// tokens back (re-emitted here as the usual llm.* events) and persists the transcript, which
// then reaches this device through ordinary sync.
func (c *Core) sendRemote(chat *domain.Chat, agent *domain.Agent, text string) ([]byte, error) {
	host := "its host"
	if agent.HostName != nil && *agent.HostName != "" {
		host = *agent.HostName
	}
	if c.relay == nil {
		err := fmt.Errorf("%s runs on %s; sign in to sync on both devices to chat with it from here", agent.Name, host)
		c.emitLLMError(chat.ID, err)
		return nil, err
	}
	if !c.deviceOnline(*agent.HostDeviceID) {
		err := fmt.Errorf("%s is offline; %s will be available when it is back", host, agent.Name)
		c.emitLLMError(chat.ID, err)
		return nil, fmt.Errorf("%w: %v", errHostOffline, err)
	}
	if err := c.startRemoteTurn(chat, agent, text); err != nil {
		c.emitLLMError(chat.ID, err)
		return nil, err
	}
	return json.Marshal(map[string]any{"ok": true, "working": true, "remote": true})
}

// startRemoteTurn pushes this device's rows (so the host sees the chat and the user turn), posts
// the request, and streams the response on a goroutine tied to the chat's working state.
func (c *Core) startRemoteTurn(chat *domain.Chat, agent *domain.Agent, text string) error {
	if _, err := c.syncRun(); err != nil {
		return fmt.Errorf("sync before sending: %w", err)
	}
	payload, err := c.seal(map[string]any{
		"chatId": chat.ID, "text": text, "agentId": agent.ID, "model": chatDerefStr(chat.Model), "resume": true,
	})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	var ack struct {
		RequestID string `json:"requestId"`
	}
	if err := c.relay.postJSON(ctx, "/v1/relay/request", map[string]any{
		"toDeviceId": *agent.HostDeviceID, "method": "chats.send", "payload": payload,
	}, &ack); err != nil {
		cancel()
		if errors.Is(err, errHostOffline) {
			c.setPresence(*agent.HostDeviceID, presenceEntry{online: false, lastSeenAt: time.Now()})
			return fmt.Errorf("%s is offline right now", agentHost(agent))
		}
		return err
	}
	c.relay.mu.Lock()
	c.relay.inflight[chat.ID] = func() {
		cancel()
		go func() {
			_ = c.relay.postJSON(context.Background(), "/v1/relay/cancel/"+ack.RequestID, map[string]any{}, nil)
		}()
	}
	c.relay.mu.Unlock()
	c.setWorking(chat.ID, cancel)
	go c.followRemoteTurn(ctx, chat.ID, ack.RequestID)
	return nil
}

func agentHost(a *domain.Agent) string {
	if a.HostName != nil && *a.HostName != "" {
		return *a.HostName
	}
	return "The computer hosting " + a.Name
}

// followRemoteTurn streams one request's response frames into this chat's events.
func (c *Core) followRemoteTurn(ctx context.Context, chatID, requestID string) {
	defer func() {
		c.relay.mu.Lock()
		delete(c.relay.inflight, chatID)
		c.relay.mu.Unlock()
		// The host persisted the reply; pull it so chat.changed shows canonical rows.
		if ctx.Err() == nil {
			_, _ = c.syncRun()
		}
		c.finishRun(chatID)
	}()
	res, err := c.relay.openSSE(ctx, "/v1/relay/response/"+requestID)
	if err != nil {
		if ctx.Err() == nil {
			c.emitLLMError(chatID, err)
		}
		return
	}
	defer res.Body.Close()
	_ = readSSE(res.Body, func(event string, data []byte) bool {
		var f wireFrame
		if json.Unmarshal(data, &f) != nil {
			return true
		}
		switch f.Type {
		case relayDelta:
			var text string
			if c.open(f.Payload, &text) == nil && text != "" {
				p, _ := json.Marshal(map[string]string{"chatId": chatID, "text": text})
				c.emit(eventLLMToken, p)
			}
		case relayTool:
			var tool json.RawMessage
			if c.open(f.Payload, &tool) == nil {
				// The host's llm.tool payload minus its chatId, re-tagged for this chat.
				var obj map[string]json.RawMessage
				if json.Unmarshal(tool, &obj) == nil {
					obj["chatId"] = mustJSONBytes(chatID)
					p, _ := json.Marshal(obj)
					c.emit(eventLLMTool, p)
				}
			}
		case relayError:
			msg := f.Error
			if f.Payload != "" {
				var s string
				if c.open(f.Payload, &s) == nil {
					msg = s
				}
			}
			if msg == "host_timeout" {
				msg = "The host stopped responding"
			}
			c.emitLLMError(chatID, errors.New(msg))
			return false
		case relayDone:
			return false
		}
		return true
	})
}

// requestModels asks the host for an agent's model list.
func (c *Core) remoteModels(agent *domain.Agent) ([]byte, error) {
	if c.relay == nil || !c.deviceOnline(*agent.HostDeviceID) {
		// Offline host: the composer falls back to a free-text model field.
		return json.Marshal([]string{})
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	payload, err := c.seal(map[string]any{"agentId": agent.ID})
	if err != nil {
		return nil, err
	}
	var ack struct {
		RequestID string `json:"requestId"`
	}
	if err := c.relay.postJSON(ctx, "/v1/relay/request", map[string]any{
		"toDeviceId": *agent.HostDeviceID, "method": "agents.models", "payload": payload,
	}, &ack); err != nil {
		if errors.Is(err, errHostOffline) {
			return json.Marshal([]string{})
		}
		return nil, err
	}
	res, err := c.relay.openSSE(ctx, "/v1/relay/response/"+ack.RequestID)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	models := []string{}
	var failure error
	_ = readSSE(res.Body, func(event string, data []byte) bool {
		var f wireFrame
		if json.Unmarshal(data, &f) != nil {
			return true
		}
		switch f.Type {
		case relayDone:
			_ = c.open(f.Payload, &models)
			return false
		case relayError:
			msg := f.Error
			var s string
			if f.Payload != "" && c.open(f.Payload, &s) == nil {
				msg = s
			}
			failure = errors.New(msg)
			return false
		}
		return true
	})
	if failure != nil {
		return nil, failure
	}
	return json.Marshal(models)
}

// --- host role --------------------------------------------------------------------

// startHosting opens the relay inbox loop if this device can host and isn't already hosting.
func (c *Core) startHosting() {
	if c.relay == nil || !c.device.canHost {
		return
	}
	c.relay.mu.Lock()
	if c.relay.hostCancel != nil {
		c.relay.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	c.relay.hostCancel = cancel
	c.relay.mu.Unlock()
	go c.hostLoop(ctx)
}

// stopHosting closes the inbox (the server marks this device offline).
func (c *Core) stopHosting() {
	if c.relay == nil {
		return
	}
	c.relay.mu.Lock()
	cancel := c.relay.hostCancel
	c.relay.hostCancel = nil
	c.relay.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// hostLoop keeps the inbox open, reconnecting with backoff, and dispatches each frame.
func (c *Core) hostLoop(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		res, err := c.relay.openSSE(ctx, "/v1/relay/inbox")
		if err != nil {
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			if backoff < 30*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = time.Second
		_ = readSSE(res.Body, func(event string, data []byte) bool {
			var f wireFrame
			if json.Unmarshal(data, &f) != nil {
				return true
			}
			switch f.Type {
			case "request":
				go c.serveRelayRequest(ctx, f)
			case "cancel":
				c.relay.mu.Lock()
				cancel := c.relay.hosting[f.RequestID]
				c.relay.mu.Unlock()
				if cancel != nil {
					cancel()
				}
			}
			return ctx.Err() == nil
		})
		res.Body.Close()
	}
}

// postFrames sends response frames for a request this device is serving.
func (c *Core) postFrames(requestID string, frames []map[string]any) {
	_ = c.relay.postJSON(context.Background(), "/v1/relay/response/"+requestID, map[string]any{"frames": frames}, nil)
}

func (c *Core) postError(requestID string, err error) {
	payload, _ := c.seal(err.Error())
	c.postFrames(requestID, []map[string]any{{"type": relayError, "payload": payload}})
}

// serveRelayRequest runs one remote request against this core.
func (c *Core) serveRelayRequest(parent context.Context, f wireFrame) {
	if !relayAllowedMethods[f.Method] {
		c.postError(f.RequestID, fmt.Errorf("method %q is not allowed over the relay", f.Method))
		return
	}
	var args map[string]any
	if err := c.open(f.Payload, &args); err != nil {
		c.postError(f.RequestID, fmt.Errorf("could not read request: %w", err))
		return
	}
	switch f.Method {
	case "agents.models":
		out, err := c.agentsModels(mustJSONBytes(args))
		if err != nil {
			c.postError(f.RequestID, err)
			return
		}
		var models []string
		_ = json.Unmarshal(out, &models)
		payload, _ := c.seal(models)
		c.postFrames(f.RequestID, []map[string]any{{"type": relayDone, "payload": payload}})
	case "chats.cancel":
		chatID, _ := args["chatId"].(string)
		c.cancelChat(chatID)
		c.postFrames(f.RequestID, []map[string]any{{"type": relayDone}})
	case "chats.send":
		c.serveRemoteChat(parent, f.RequestID, args)
	}
}

// serveRemoteChat runs a caller's turn locally and streams the chat's events back as frames.
func (c *Core) serveRemoteChat(parent context.Context, requestID string, args map[string]any) {
	chatID, _ := args["chatId"].(string)
	if chatID == "" {
		c.postError(requestID, errors.New("chatId is required"))
		return
	}
	// The caller pushed its chat + user turn before asking; pull them in.
	if _, err := c.syncRun(); err != nil {
		c.postError(requestID, fmt.Errorf("sync before running: %w", err))
		return
	}
	if _, err := c.store.Chats.Get(chatID); errors.Is(err, store.ErrNotFound) {
		c.postError(requestID, errors.New("the chat has not reached this device yet; try again"))
		return
	}
	args["resume"] = true

	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	c.relay.mu.Lock()
	c.relay.hosting[requestID] = func() { c.cancelChat(chatID); cancel() }
	c.relay.hostChats[requestID] = chatID
	c.relay.mu.Unlock()
	defer func() {
		c.relay.mu.Lock()
		delete(c.relay.hosting, requestID)
		delete(c.relay.hostChats, requestID)
		c.relay.mu.Unlock()
	}()

	// Forward this chat's stream. Deltas are coalesced (~50ms) into one frame batch to keep
	// the server round-trips proportional to time, not tokens.
	done := make(chan struct{}, 1)
	var (
		fmu     sync.Mutex
		pending []map[string]any
		failed  error
	)
	enqueue := func(frame map[string]any) {
		fmu.Lock()
		pending = append(pending, frame)
		fmu.Unlock()
	}
	untap := c.tapEvents(func(name string, payload []byte) {
		var tag struct {
			ChatID  string `json:"chatId"`
			Working *bool  `json:"working"`
			Text    string `json:"text"`
			Error   string `json:"error"`
		}
		if json.Unmarshal(payload, &tag) != nil || tag.ChatID != chatID {
			return
		}
		switch name {
		case eventLLMToken:
			p, _ := c.seal(tag.Text)
			enqueue(map[string]any{"type": relayDelta, "payload": p})
		case eventLLMTool:
			p, _ := c.seal(json.RawMessage(payload))
			enqueue(map[string]any{"type": relayTool, "payload": p})
		case eventLLMError:
			fmu.Lock()
			failed = errors.New(tag.Error)
			fmu.Unlock()
		case eventChatWorking:
			if tag.Working != nil && !*tag.Working {
				select {
				case done <- struct{}{}:
				default:
				}
			}
		}
	})
	defer untap()

	if _, err := c.chatsSend(mustJSONBytes(args)); err != nil {
		c.postError(requestID, err)
		return
	}

	flush := func() {
		fmu.Lock()
		batch := pending
		pending = nil
		fmu.Unlock()
		if len(batch) > 0 {
			c.postFrames(requestID, batch)
		}
	}
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			c.cancelChat(chatID)
			flush()
			return
		case <-tick.C:
			flush()
		case <-done:
			flush()
			fmu.Lock()
			err := failed
			fmu.Unlock()
			// Push the persisted reply so the caller's follow-up sync finds it.
			_, _ = c.syncRun()
			if err != nil {
				c.postError(requestID, err)
			} else {
				c.postFrames(requestID, []map[string]any{{"type": relayDone}})
			}
			return
		}
	}
}
