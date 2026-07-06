// Package bridge is the single API surface every platform speaks: a string method
// plus JSON bytes in, JSON bytes out, plus an event stream (PLAN §3.1). Desktop
// imports it directly; wasm and gomobile wrap the same Core.
package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"

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

// SecretStore is the platform-provided keychain the core reads LLM API keys from at chat
// time (PLAN §6.8): keychain on macOS, SecureStore on mobile, DPAPI on Windows. Keys are
// referenced by an opaque handle (llm_configs.api_key_ref); the values never touch SQLite.
// The shell injects an implementation via SetSecretStore; when absent, cloud LLM configs
// that need a key error clearly rather than sending an empty credential.
type SecretStore interface {
	GetSecret(ref string) (string, error)
	SetSecret(ref, value string) error
	DeleteSecret(ref string) error
}

// Core is the shared application core. It is safe to construct once per process.
type Core struct {
	store   *store.Store
	handler EventHandler
	sync    syncConfig
	secrets SecretStore

	// Chat runs execute on background goroutines so an answer keeps generating (and is saved)
	// even when the user navigates away (§6.8). working tracks the chats with a live run, so
	// lists can show a spinner; guarded by chatMu.
	chatMu  sync.Mutex
	working map[string]bool
}

// New builds a Core over an already-open store.
func New(st *store.Store) *Core {
	return &Core{store: st, working: map[string]bool{}}
}

// SetEventHandler registers the sink for events emitted by the core.
func (c *Core) SetEventHandler(h EventHandler) { c.handler = h }

// SetSecretStore registers the platform keychain used for LLM API keys (§6.8).
func (c *Core) SetSecretStore(s SecretStore) { c.secrets = s }

// emit fans an event out to the registered handler, if any. payload is the
// already-marshalled JSON body for the event.
func (c *Core) emit(name string, payload []byte) {
	if c.handler != nil {
		c.handler.OnEvent(name, payload)
	}
}

// dataChangedEvent is the generic "something changed, refresh" signal (PLAN §5.4). The
// graph view, sidebar, and embedded-task NodeViews subscribe to it. An empty entityType
// means a bulk change (a full sync or rebuild).
const dataChangedEvent = "data.changed"

// emitDataChanged notifies subscribers that an entity (or, with empty args, many)
// changed. Handlers that only need "refresh" can ignore the payload.
func (c *Core) emitDataChanged(entityType, id string) {
	payload, _ := json.Marshal(map[string]string{"entityType": entityType, "id": id})
	c.emit(dataChangedEvent, payload)
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
	case "notes.hold":
		return c.notesHold(payload)
	case "notes.release":
		return c.notesRelease()
	case "notes.conflict":
		return c.notesConflict()
	case "notes.conflictResolve":
		return c.notesConflictResolve(payload)
	case "tasks.list":
		return c.tasksList()
	case "tasks.get":
		return c.tasksGet(payload)
	case "tasks.create":
		return c.tasksCreate(payload)
	case "tasks.update":
		return c.tasksUpdate(payload)
	case "tasks.delete":
		return c.tasksDelete(payload)
	case "notify.plan":
		return c.notifyPlan(payload)
	case "dates.parse":
		return c.datesParse(payload)
	case "trash.list":
		return c.trashList()
	case "trash.restore":
		return c.trashRestore(payload)
	case "trash.purge":
		return c.trashPurge(payload)
	case "areas.list":
		return c.areasList()
	case "areas.create":
		return c.areasCreate(payload)
	case "areas.update":
		return c.areasUpdate(payload)
	case "areas.reorder":
		return c.areasReorder(payload)
	case "areas.delete":
		return c.areasDelete(payload)
	case "projects.list":
		return c.projectsList()
	case "projects.create":
		return c.projectsCreate(payload)
	case "projects.update":
		return c.projectsUpdate(payload)
	case "projects.reorder":
		return c.projectsReorder(payload)
	case "projects.delete":
		return c.projectsDelete(payload)
	case "projects.addMember":
		return c.projectsAddMember(payload)
	case "projects.removeMember":
		return c.projectsRemoveMember(payload)
	case "projects.members":
		return c.projectsMembers(payload)
	case "projects.forEntity":
		return c.projectsForEntity(payload)
	case "nav.sidebar":
		return c.navSidebar()
	case "sync.configure":
		return c.syncConfigure(payload)
	case "sync.run":
		return c.syncRun()
	case "graph.full":
		return c.graphFull()
	case "graph.neighborhood":
		return c.graphNeighborhood(payload)
	case "graph.backlinks":
		return c.graphBacklinks(payload)
	case "graph.search":
		return c.graphSearch(payload)
	case "graph.lookup":
		return c.graphLookup(payload)
	case "graph.rebuild":
		return c.graphRebuild()
	case "llm.configs.list":
		return c.llmConfigsList()
	case "llm.configs.create":
		return c.llmConfigsCreate(payload)
	case "llm.configs.update":
		return c.llmConfigsUpdate(payload)
	case "llm.configs.delete":
		return c.llmConfigsDelete(payload)
	case "llm.configs.setDefault":
		return c.llmConfigsSetDefault(payload)
	case "chats.list":
		return c.chatsList()
	case "chats.get":
		return c.chatsGet(payload)
	case "chats.create":
		return c.chatsCreate(payload)
	case "chats.rename":
		return c.chatsRename(payload)
	case "chats.delete":
		return c.chatsDelete(payload)
	case "chats.send":
		return c.chatsSend(payload)
	case "chats.working":
		return c.chatsWorking()
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
