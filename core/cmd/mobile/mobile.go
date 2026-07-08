// Package mobile is the gomobile-bindable entrypoint for iOS and Android (PLAN §3.2).
//
// `gomobile bind` restricts exported types to basic types, []byte, error, and
// interfaces/structs whose methods use only those — which is exactly the core's
// universal "string method + JSON bytes in/out + event stream" API (PLAN §3.1). It
// binds to Core.xcframework (iOS) and core.aar (Android), wrapped by a local Expo
// module (see apps/mobile) that exposes invoke + an event emitter to JS.
//
// The database is the same native store as desktop (modernc.org/sqlite), so all of
// the tested core logic runs unchanged on device.
package mobile

import (
	"path/filepath"

	"companion/core/blob"
	"companion/core/bridge"
	"companion/core/secrets"
	"companion/core/store"
)

// EventHandler receives core events (data-changed refresh hints, sync progress, LLM
// token streams). The Expo module implements this in Swift/Kotlin and forwards each
// event to a JS event emitter.
type EventHandler interface {
	OnEvent(name string, payload []byte)
}

// Core is the bindable handle. gomobile exposes its exported methods to Swift/Kotlin.
type Core struct {
	inner *bridge.Core
	store *store.Store
}

// New opens (or creates) the SQLite database at dbPath and returns a ready Core. The
// Expo module passes a writable path inside the app's documents directory.
func New(dbPath string) (*Core, error) {
	st, err := store.Open(dbPath, nil)
	if err != nil {
		return nil, err
	}
	core := bridge.New(st)
	// LLM API keys (PLAN §6.8): stored beside the database in the app's documents dir.
	// SecureStore is the intended hardening upgrade; local Ollama needs no key.
	core.SetSecretStore(secrets.NewFileStore(filepath.Join(filepath.Dir(dbPath), "secrets.json")))
	// Document bytes (PLAN §6.9): a filesystem blob store in the app's documents dir. The RN
	// shell ingests picked files (documents.ingestFile) and reads bytes back by path
	// (documents.localPath) from this same store; the core syncs them out-of-band.
	if blobStore, err := blob.NewFSStore(filepath.Join(filepath.Dir(dbPath), "blobs"), nil); err == nil {
		core.SetBlobStore(blobStore)
	}
	return &Core{inner: core, store: st}, nil
}

// Invoke dispatches a core method: JSON-encoded payload in, JSON-encoded result out.
func (c *Core) Invoke(method string, payload []byte) ([]byte, error) {
	return c.inner.Invoke(method, payload)
}

// SetEventHandler registers (or clears, when nil) the sink for core events.
func (c *Core) SetEventHandler(h EventHandler) {
	if h == nil {
		c.inner.SetEventHandler(nil)
		return
	}
	c.inner.SetEventHandler(eventAdapter{h})
}

// Close releases the underlying store.
func (c *Core) Close() error {
	return c.store.Close()
}

// eventAdapter bridges the gomobile-exported EventHandler to bridge.EventHandler.
type eventAdapter struct{ h EventHandler }

func (a eventAdapter) OnEvent(name string, payload []byte) {
	// gomobile marshals a nil []byte as a null on the Java/Swift side; a Kotlin handler
	// with a non-null parameter would then crash. Normalize to an empty (non-nil) slice
	// so payload-less events cross the bridge as an empty byte array.
	if payload == nil {
		payload = []byte{}
	}
	a.h.OnEvent(name, payload)
}
