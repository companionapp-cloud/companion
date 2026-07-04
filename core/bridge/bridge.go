// Package bridge is the single API surface every platform speaks: a string method
// plus JSON bytes in, JSON bytes out, plus an event stream (PLAN §3.1). Desktop
// imports it directly; wasm and gomobile wrap the same Core.
package bridge

import (
	"encoding/json"
	"errors"
	"fmt"

	"companion/core/store"
)

// Version is the bridge API version. Clients refuse to run against an incompatible
// artifact by comparing this via the "core.version" method (PLAN §8).
const Version = "1"

// EventHandler receives out-of-band events (LLM token streams, sync progress,
// "data changed" refresh hints). The platform shell forwards them to the UI.
type EventHandler interface {
	OnEvent(name string, payload []byte)
}

// Core is the shared application core. It is safe to construct once per process.
type Core struct {
	store   *store.Store
	handler EventHandler
	sync    syncConfig
}

// New builds a Core over an already-open store.
func New(st *store.Store) *Core {
	return &Core{store: st}
}

// SetEventHandler registers the sink for events emitted by the core.
func (c *Core) SetEventHandler(h EventHandler) { c.handler = h }

// emit fans an event out to the registered handler, if any. payload is the
// already-marshalled JSON body for the event.
func (c *Core) emit(name string, payload []byte) {
	if c.handler != nil {
		c.handler.OnEvent(name, payload)
	}
}

// Invoke dispatches a method by name. payload is the JSON-encoded argument (may be
// nil for methods that take none); the result is JSON-encoded. Handlers own their
// own argument/return marshalling.
func (c *Core) Invoke(method string, payload []byte) ([]byte, error) {
	switch method {
	case "core.version":
		return json.Marshal(map[string]string{"version": Version})
	case "notes.list":
		return c.notesList()
	case "notes.get":
		return c.notesGet(payload)
	case "notes.create":
		return c.notesCreate(payload)
	case "notes.update":
		return c.notesUpdate(payload)
	case "notes.delete":
		return c.notesDelete(payload)
	case "sync.configure":
		return c.syncConfigure(payload)
	case "sync.run":
		return c.syncRun()
	default:
		return nil, fmt.Errorf("unknown method %q", method)
	}
}

// unmarshal decodes a payload into v, tolerating an empty/nil payload as "{}".
func unmarshal(payload []byte, v any) error {
	if len(payload) == 0 {
		return nil
	}
	if err := json.Unmarshal(payload, v); err != nil {
		return fmt.Errorf("decode payload: %w", err)
	}
	return nil
}

// mapStoreErr translates internal store errors into stable, client-facing errors.
func mapStoreErr(err error) error {
	if errors.Is(err, store.ErrNotFound) {
		return errors.New("not found")
	}
	return err
}
