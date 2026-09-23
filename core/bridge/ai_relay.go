package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"companion/core/domain"
)

// Editor assists on an agent hosted by another device (a phone using the Claude Code on a Mac):
// the run goes through the relay like a chat turn does (relay.go), minus the sync — an assist
// persists nothing, so the request carries everything the host needs. The caller re-emits the
// host's frames as its own ai.* events for its run id, so the editor can't tell the difference.

// aiRemote reports whether the agent runs on another device.
func (c *Core) aiRemote(a *domain.Agent) bool {
	me, _ := c.store.EnsureDeviceID()
	return a.IsLocal() && !a.IsHostedBy(me)
}

// aiRunRemote hands a run to the agent's host and follows its response stream.
func (c *Core) aiRunRemote(args aiRunArgs, agent *domain.Agent) ([]byte, error) {
	runID := args.RunID
	// The host names its own run and resolves the model when none was picked here.
	args.RunID = ""
	args.AgentID = agent.ID
	payload, err := c.seal(args)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithCancel(context.Background())
	c.chatMu.Lock()
	if _, busy := c.aiRuns[runID]; busy {
		c.chatMu.Unlock()
		cancel()
		return nil, errors.New("this run is already in progress")
	}
	c.aiRuns[runID] = cancel
	c.chatMu.Unlock()
	fail := func(err error) ([]byte, error) {
		cancel()
		c.chatMu.Lock()
		delete(c.aiRuns, runID)
		c.chatMu.Unlock()
		return nil, err
	}

	var ack struct {
		RequestID string `json:"requestId"`
	}
	if err := c.relay.postJSON(ctx, "/v1/relay/request", map[string]any{
		"toDeviceId": *agent.HostDeviceID, "method": "ai.run", "payload": payload,
	}, &ack); err != nil {
		if errors.Is(err, errHostOffline) {
			return fail(fmt.Errorf("%s is offline right now", agentHost(agent)))
		}
		return fail(err)
	}
	// Cancelling also tells the host to stop.
	c.chatMu.Lock()
	c.aiRuns[runID] = func() {
		cancel()
		go func() {
			_ = c.relay.postJSON(context.Background(), "/v1/relay/cancel/"+ack.RequestID, map[string]any{}, nil)
		}()
	}
	c.chatMu.Unlock()

	go c.followRemoteAI(ctx, runID, ack.RequestID)
	return json.Marshal(map[string]any{"ok": true, "runId": runID, "agent": agent.Name, "model": args.Model, "remote": true})
}

// followRemoteAI re-emits one relayed run's frames as this device's ai.* events.
func (c *Core) followRemoteAI(ctx context.Context, runID, requestID string) {
	defer func() {
		c.chatMu.Lock()
		delete(c.aiRuns, runID)
		c.chatMu.Unlock()
	}()
	emitErr := func(msg string) {
		p, _ := json.Marshal(map[string]string{"runId": runID, "error": msg})
		c.emit(eventAIError, p)
	}
	res, err := c.relay.openSSE(ctx, "/v1/relay/response/"+requestID)
	if err != nil {
		if ctx.Err() == nil {
			emitErr(err.Error())
		}
		return
	}
	defer res.Body.Close()
	finished := false
	_ = readSSE(res.Body, func(_ string, data []byte) bool {
		var f wireFrame
		if json.Unmarshal(data, &f) != nil {
			return true
		}
		switch f.Type {
		case relayDelta:
			var text string
			if c.open(f.Payload, &text) == nil && text != "" {
				p, _ := json.Marshal(map[string]string{"runId": runID, "text": text})
				c.emit(eventAIDelta, p)
			}
		case relayDone:
			var done map[string]any
			if err := c.open(f.Payload, &done); err != nil {
				emitErr("could not read the host's answer")
			} else {
				done["runId"] = runID
				p, _ := json.Marshal(done)
				c.emit(eventAIDone, p)
			}
			finished = true
			return false
		case relayError:
			msg := f.Error
			var s string
			if f.Payload != "" && c.open(f.Payload, &s) == nil {
				msg = s
			}
			emitErr(msg)
			finished = true
			return false
		}
		return true
	})
	if !finished && ctx.Err() == nil {
		emitErr("lost the connection to the agent's host")
	}
}

// serveRemoteAI runs a caller's assist on this (hosting) device and streams it back as frames.
func (c *Core) serveRemoteAI(parent context.Context, requestID string, args map[string]any) {
	runID := "relay-" + requestID
	args["runId"] = runID

	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	c.relay.mu.Lock()
	c.relay.hosting[requestID] = func() {
		_, _ = c.aiCancel(mustJSONBytes(map[string]string{"runId": runID}))
		cancel()
	}
	c.relay.mu.Unlock()
	defer func() {
		c.relay.mu.Lock()
		delete(c.relay.hosting, requestID)
		c.relay.mu.Unlock()
	}()

	// Deltas are coalesced (~50ms) into frame batches, as for chats; the terminal event ends it.
	var (
		fmu      sync.Mutex
		pending  []map[string]any
		terminal map[string]any
	)
	ended := make(chan struct{}, 1)
	untap := c.tapEvents(func(name string, payload []byte) {
		var tag struct {
			RunID string `json:"runId"`
			Text  string `json:"text"`
			Error string `json:"error"`
		}
		if json.Unmarshal(payload, &tag) != nil || tag.RunID != runID {
			return
		}
		var frame map[string]any
		switch name {
		case eventAIDelta:
			p, _ := c.seal(tag.Text)
			fmu.Lock()
			pending = append(pending, map[string]any{"type": relayDelta, "payload": p})
			fmu.Unlock()
			return
		case eventAIDone:
			p, _ := c.seal(json.RawMessage(payload))
			frame = map[string]any{"type": relayDone, "payload": p}
		case eventAIError:
			p, _ := c.seal(tag.Error)
			frame = map[string]any{"type": relayError, "payload": p}
		default:
			return
		}
		fmu.Lock()
		terminal = frame
		fmu.Unlock()
		select {
		case ended <- struct{}{}:
		default:
		}
	})
	defer untap()

	if _, err := c.aiRun(mustJSONBytes(args)); err != nil {
		c.postError(requestID, err)
		return
	}

	flush := func(final bool) {
		fmu.Lock()
		batch := pending
		pending = nil
		if final && terminal != nil {
			batch = append(batch, terminal)
		}
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
			return
		case <-tick.C:
			flush(false)
		case <-ended:
			flush(true)
			return
		}
	}
}
