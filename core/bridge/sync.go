package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	cryptopkg "companion/core/crypto"
	syncpkg "companion/core/sync"
)

// syncConfig holds the server endpoint + bearer token the client syncs against. The
// shell obtains the token from auth (register/login) and stores it in the OS keychain
// / SecureStore; here it is held in memory for the process lifetime.
type syncConfig struct {
	baseURL  string
	token    string
	deviceID string
}

func (c *Core) syncConfigure(payload []byte) ([]byte, error) {
	var args struct {
		BaseURL string `json:"baseUrl"`
		Token   string `json:"token"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if args.BaseURL == "" {
		return nil, errors.New("baseUrl is required")
	}
	// The device id is minted once per install (store.EnsureDeviceID) and reused here, so it is
	// stable across restarts and matches the id local agents are pinned to.
	id, err := c.store.EnsureDeviceID()
	if err != nil {
		return nil, err
	}
	c.sync.deviceID = id
	c.sync.baseURL = args.BaseURL
	c.sync.token = args.Token
	// Relay + presence (PLAN-agents.md §5): register this device and, on a desktop that can
	// host, keep the relay inbox open so other devices can drive the agents installed here.
	// Reconfiguring (a token refresh) just updates credentials; the inbox loop keeps running.
	if c.relay == nil {
		c.relay = newRelayClient(args.BaseURL, args.Token, id)
	} else {
		c.relay.setCreds(args.BaseURL, args.Token)
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := c.registerDevice(ctx); err != nil {
			return // best effort; the next sync's header heartbeat keeps last_seen fresh
		}
		_ = c.refreshPresence(ctx)
		c.startHosting()
	}()
	return json.Marshal(map[string]bool{"ok": true})
}

// syncDisconnect forgets the server, stops hosting (so this device reads as offline elsewhere)
// and clears presence.
func (c *Core) syncDisconnect() ([]byte, error) {
	c.stopHosting()
	c.sync.baseURL, c.sync.token = "", ""
	c.relay = nil
	c.presence.mu.Lock()
	c.presence.devices = nil
	c.presence.mu.Unlock()
	c.emitAgentsChanged()
	return json.Marshal(map[string]bool{"ok": true})
}

// newSyncEngine builds a sync engine against the configured endpoint, enabling end-to-end
// encryption when the store is unlocked. A nil master key leaves it in plaintext mode — the shell
// must unlock before syncing an encrypted account, or it would push plaintext (PLAN §E2EE).
func (c *Core) newSyncEngine() *syncpkg.Engine {
	transport := syncpkg.NewHTTPTransport(c.sync.baseURL, c.sync.token)
	transport.DeviceID = c.sync.deviceID
	engine := syncpkg.New(c.store, transport, nil)
	if mk := c.getMasterKey(); mk != nil {
		engine.SetCipher(cryptopkg.NewCipher(mk))
	}
	return engine
}

// syncRun performs one push→pull cycle and signals the UI to refresh.
func (c *Core) syncRun() ([]byte, error) {
	if c.sync.baseURL == "" {
		return nil, errors.New("sync is not configured")
	}
	// Upload any pending document bytes first, so the engine only pushes metadata whose
	// bytes are already fetchable by other devices (upload-before-push, PLAN §6.9).
	if err := c.uploadPendingBlobs(); err != nil {
		return nil, err
	}
	if err := c.newSyncEngine().Sync(); err != nil {
		return nil, err
	}
	// A pull may have applied many rows (and re-derived their links); signal a bulk
	// change so notes lists and the graph both refresh.
	c.emit(notesChangedEvent, nil)
	c.emitDataChanged("", "")
	// If the pull stashed a conflicting server version for a note the UI holds open,
	// prompt the open editor to resolve it (see hold.go / notes.conflict).
	if pc := c.store.Notes.PendingConflict(); pc != nil {
		payload, _ := json.Marshal(noteConflictInfo(pc))
		c.emit(notesConflictEvent, payload)
	}
	// Presence piggybacks on the sync cadence: who is online decides which hosted agents the
	// composer lets you pick. Best effort and off the critical path.
	if c.relay != nil {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = c.refreshPresence(ctx)
		}()
	}
	return json.Marshal(map[string]bool{"ok": true})
}
