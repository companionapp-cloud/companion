// Package bridge is the single API surface every platform speaks: a string method
// plus JSON bytes in, JSON bytes out, plus an event stream (PLAN §3.1). Desktop
// imports it directly; wasm and gomobile wrap the same Core.
package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"companion/core/agents"
	"companion/core/blob"
	"companion/core/mcp"
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
	// blobs is the platform blob store for document bytes (PLAN §6.9). The shell injects a
	// filesystem impl (desktop/mobile) or an OPFS+fetch impl (web) via SetBlobStore. When
	// absent, document metadata still syncs but bytes cannot transfer — sync skips the
	// blob pass and rendering must fall back to "not downloaded".
	blobs blob.Store

	// Local agents (PLAN-agents.md): the desktop shell injects a discoverer (scan this machine
	// for Claude Code / Codex / Ollama / LM Studio) and a runner factory (drive the CLI ones as
	// child processes). Other shells leave both nil: discovery returns nothing and hosted
	// agents are reached through the relay.
	discoverer agents.Discoverer
	runners    agents.RunnerFactory
	device     deviceShell
	presence   presenceTable
	relay      *relayClient
	// mcp serves Companion's tools to CLI agents (PLAN-agents.md §4.5); started lazily on the
	// first CLI run. mcpTokens maps agent id → its issued bearer token.
	mcp       *mcp.Server
	mcpTokens map[string]string
	tapMu     sync.Mutex
	taps      map[int]func(string, []byte)
	tapSeq    int

	// Chat runs execute on background goroutines so an answer keeps generating (and is saved)
	// even when the user navigates away (§6.8). working maps each chat with a live run to the
	// cancel func that aborts it (chats.cancel), so lists can show a spinner and the user can
	// stop a runaway CLI; guarded by chatMu.
	chatMu  sync.Mutex
	working map[string]context.CancelFunc
	// aiRuns maps each live editor-assist run (ai.go) to its cancel func; guarded by chatMu.
	aiRuns map[string]context.CancelFunc

	// calPushTimer debounces the provider push after the assistant edits calendar events
	// (aitools.go); guarded by calPushMu.
	calPushMu    sync.Mutex
	calPushTimer *time.Timer

	// masterKey is the unlocked end-to-end encryption key (PLAN §E2EE): non-nil means the store
	// is unlocked and sync transparently encrypts/decrypts; nil means locked or a plaintext
	// account. Held only in memory; guarded by cryptoMu since sync and the crypto.* methods can
	// touch it concurrently.
	cryptoMu  sync.Mutex
	masterKey []byte

	// oauth holds provider configuration, in-flight sign-ins and cached access tokens
	// (oauth.go). Generic: calendar accounts are its first user, not its owner.
	oauth *oauthState

	// importCancel stops the one import that may run at a time (imports.go, PLAN §6.12); nil
	// when none is. importFiles reads files the user picked by handle — set by the web shell,
	// which stages uploads (native shells pass paths). Guarded by importMu.
	importMu     sync.Mutex
	importCancel context.CancelFunc
	importFiles  func(handle string) ([]byte, error)

	// exports is the scheduled-export scheduler's state (export.go).
	exports exportState
}

// New builds a Core over an already-open store.
func New(st *store.Store) *Core {
	c := &Core{store: st, working: map[string]context.CancelFunc{}, aiRuns: map[string]context.CancelFunc{}, oauth: newOAuthState()}
	c.registerPlatformOAuthPurposes()
	return c
}

// SetEventHandler registers the sink for events emitted by the core.
func (c *Core) SetEventHandler(h EventHandler) { c.handler = h }

// SetSecretStore registers the platform keychain used for LLM API keys (§6.8).
func (c *Core) SetSecretStore(s SecretStore) { c.secrets = s }

// SetBlobStore registers the platform store for document bytes (PLAN §6.9).
func (c *Core) SetBlobStore(b blob.Store) { c.blobs = b }

// SetAgentDiscoverer registers the local-tool scanner (desktop only, PLAN-agents.md §3).
func (c *Core) SetAgentDiscoverer(d agents.Discoverer) { c.discoverer = d }

// SetAgentRunners registers the CLI runner factory (desktop only, PLAN-agents.md §4).
func (c *Core) SetAgentRunners(f agents.RunnerFactory) { c.runners = f }

// emit fans an event out to the registered handler, if any. payload is the
// already-marshalled JSON body for the event.
func (c *Core) emit(name string, payload []byte) {
	if c.handler != nil {
		c.handler.OnEvent(name, payload)
	}
	c.tapMu.Lock()
	taps := make([]func(string, []byte), 0, len(c.taps))
	for _, t := range c.taps {
		taps = append(taps, t)
	}
	c.tapMu.Unlock()
	for _, t := range taps {
		t(name, payload)
	}
}

// tapEvents registers an in-process observer of every emitted event (the relay host forwards
// a chat's stream to the caller this way). It returns the function that removes the tap.
func (c *Core) tapEvents(fn func(name string, payload []byte)) func() {
	c.tapMu.Lock()
	c.tapSeq++
	id := c.tapSeq
	if c.taps == nil {
		c.taps = map[int]func(string, []byte){}
	}
	c.taps[id] = fn
	c.tapMu.Unlock()
	return func() {
		c.tapMu.Lock()
		delete(c.taps, id)
		c.tapMu.Unlock()
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
	case "notes.deleteMany":
		return c.notesDeleteMany(payload)
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
	case "tasks.listSeeds":
		return c.tasksListSeeds()
	case "tasks.repeatPreview":
		return c.tasksRepeatPreview(payload)
	case "tasks.parseRepeat":
		return c.tasksParseRepeat(payload)
	case "tasks.parseReminder":
		return c.tasksParseReminder(payload)
	case "tasks.get":
		return c.tasksGet(payload)
	case "tasks.create":
		return c.tasksCreate(payload)
	case "tasks.update":
		return c.tasksUpdate(payload)
	case "tasks.delete":
		return c.tasksDelete(payload)
	case "tasks.deleteMany":
		return c.tasksDeleteMany(payload)
	case "documents.list":
		return c.documentsList()
	case "documents.get":
		return c.documentsGet(payload)
	case "documents.create":
		return c.documentsCreate(payload)
	case "documents.rename":
		return c.documentsRename(payload)
	case "documents.delete":
		return c.documentsDelete(payload)
	case "documents.ensureLocal":
		return c.documentsEnsureLocal(payload)
	case "documents.ingestFile":
		return c.documentsIngestFile(payload)
	case "documents.ingestBytes":
		return c.documentsIngestBytes(payload)
	case "documents.localPath":
		return c.documentsLocalPath(payload)
	case "documents.dataUrl":
		return c.documentsDataURL(payload)
	case "notify.plan":
		return c.notifyPlan(payload)
	case "notify.dismissed":
		return c.notifyDismissed(payload)
	case "notify.feed":
		return c.notifyFeed(payload)
	case "notify.markRead":
		return c.notifyMarkRead(payload)
	case "notify.markAllRead":
		return c.notifyMarkAllRead(payload)
	case "dates.parse":
		return c.datesParse(payload)
	case "trash.list":
		return c.trashList()
	case "trash.restore":
		return c.trashRestore(payload)
	case "trash.purge":
		return c.trashPurge(payload)
	case "trash.empty":
		return c.trashEmpty()
	case "data.summary":
		return c.dataSummary()
	case "data.clear":
		return c.dataClear(payload)
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
	case "areas.addMember":
		return c.areasAddMember(payload)
	case "areas.addMembers":
		return c.areasAddMembers(payload)
	case "areas.removeMember":
		return c.areasRemoveMember(payload)
	case "areas.members":
		return c.areasMembers(payload)
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
	case "projects.addMembers":
		return c.projectsAddMembers(payload)
	case "projects.removeMember":
		return c.projectsRemoveMember(payload)
	case "projects.members":
		return c.projectsMembers(payload)
	case "projects.forEntity":
		return c.projectsForEntity(payload)
	case "projects.memberEntityIds":
		return c.projectsMemberEntityIds(payload)
	case "projects.somedayTaskIds":
		return c.projectsSomedayTaskIds()
	case "import.thingsScan":
		return c.importThingsScan(payload)
	case "import.thingsRun":
		return c.importThingsRun(payload)
	case "import.cancel":
		return c.importCancelRun()
	case "lists.list":
		return c.listsList(payload)
	case "lists.get":
		return c.listsGet(payload)
	case "lists.create":
		return c.listsCreate(payload)
	case "lists.update":
		return c.listsUpdate(payload)
	case "lists.reorder":
		return c.listsReorder(payload)
	case "lists.delete":
		return c.listsDelete(payload)
	case "lists.items":
		return c.listsItems(payload)
	case "lists.addTask":
		return c.listsAddTask(payload)
	case "lists.addTasks":
		return c.listsAddTasks(payload)
	case "lists.createTask":
		return c.listsCreateTask(payload)
	case "lists.addHeading":
		return c.listsAddHeading(payload)
	case "lists.updateItem":
		return c.listsUpdateItem(payload)
	case "lists.removeItem":
		return c.listsRemoveItem(payload)
	case "lists.reorderItems":
		return c.listsReorderItems(payload)
	case "lists.forTask":
		return c.listsForTask(payload)
	case "objectTypes.list":
		return c.objectTypesList()
	case "objectTypes.get":
		return c.objectTypesGet(payload)
	case "objectTypes.create":
		return c.objectTypesCreate(payload)
	case "objectTypes.update":
		return c.objectTypesUpdate(payload)
	case "objectTypes.delete":
		return c.objectTypesDelete(payload)
	case "nav.sidebar":
		return c.navSidebar()
	case "sync.configure":
		return c.syncConfigure(payload)
	case "sync.run":
		return c.syncRun()
	case "sync.disconnect":
		return c.syncDisconnect()
	case "crypto.setup":
		return c.cryptoSetup(payload)
	case "crypto.deriveAuthKey":
		return c.cryptoDeriveAuthKey(payload)
	case "crypto.unlock":
		return c.cryptoUnlock(payload)
	case "crypto.unlockWithRecovery":
		return c.cryptoUnlockWithRecovery(payload)
	case "crypto.rewrap":
		return c.cryptoRewrap(payload)
	case "crypto.unlockFromCache":
		return c.cryptoUnlockFromCache()
	case "crypto.lock":
		return c.cryptoLock()
	case "crypto.status":
		return c.cryptoStatus()
	case "crypto.reencryptAll":
		return c.cryptoReencryptAll()
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
	case "agents.list", "llm.configs.list":
		return c.agentsList()
	case "agents.install", "llm.configs.create":
		return c.agentsInstall(payload)
	case "agents.update", "llm.configs.update":
		return c.agentsUpdate(payload)
	case "agents.remove", "llm.configs.delete":
		return c.agentsRemove(payload)
	case "agents.setDefault", "llm.configs.setDefault":
		return c.agentsSetDefault(payload)
	case "agents.models":
		return c.agentsModels(payload)
	case "llm.models.list":
		return c.llmModelsList(payload)
	case "agents.discover":
		return c.agentsDiscover()
	case "devices.this":
		return c.devicesThis()
	case "devices.rename":
		return c.devicesRename(payload)
	case "devices.list":
		return c.devicesList()
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
	case "chats.cancel":
		return c.chatsCancel(payload)
	case "ai.status":
		return c.aiStatus()
	case "ai.run":
		return c.aiRun(payload)
	case "ai.cancel":
		return c.aiCancel(payload)
	case "calendar.feeds.list":
		return c.calendarFeedsList()
	case "calendar.feeds.create":
		return c.calendarFeedsCreate(payload)
	case "calendar.feeds.update":
		return c.calendarFeedsUpdate(payload)
	case "calendar.feeds.delete":
		return c.calendarFeedsDelete(payload)
	case "calendar.range":
		return c.calendarRange(payload)
	case "calendar.refresh":
		return c.calendarRefresh()
	case "calendar.push":
		return c.calendarPush()
	case "calendar.capabilities":
		return c.calendarCapabilities()
	case "oauth.configure":
		return c.oauthConfigure(payload)
	case "oauth.providers":
		return c.oauthProviders()
	case "oauth.begin":
		return c.oauthBegin(payload)
	case "oauth.complete":
		return c.oauthComplete(payload)
	case "oauth.cancel":
		return c.oauthCancel(payload)
	case "calendar.accounts.list":
		return c.calendarAccountsList()
	case "calendar.accounts.add":
		return c.calendarAccountsAdd(payload)
	case "calendar.accounts.update":
		return c.calendarAccountsUpdate(payload)
	case "calendar.accounts.rescan":
		return c.calendarAccountsRescan(payload)
	case "calendar.accounts.remove":
		return c.calendarAccountsRemove(payload)
	case "calendar.events.create":
		return c.calendarEventsCreate(payload)
	case "calendar.events.get":
		return c.calendarEventsGet(payload)
	case "calendar.events.update":
		return c.calendarEventsUpdate(payload)
	case "calendar.events.delete":
		return c.calendarEventsDelete(payload)
	case "canvases.list":
		return c.canvasesList()
	case "canvases.get":
		return c.canvasesGet(payload)
	case "canvases.create":
		return c.canvasesCreate(payload)
	case "canvases.update":
		return c.canvasesUpdate(payload)
	case "canvases.delete":
		return c.canvasesDelete(payload)
	case "canvases.deleteMany":
		return c.canvasesDeleteMany(payload)
	case "canvases.forEntity":
		return c.canvasesForEntity(payload)
	case "canvases.nodes.upsert":
		return c.canvasesNodesUpsert(payload)
	case "canvases.nodes.delete":
		return c.canvasesNodesDelete(payload)
	case "canvases.edges.upsert":
		return c.canvasesEdgesUpsert(payload)
	case "canvases.edges.delete":
		return c.canvasesEdgesDelete(payload)
	case "canvases.view.set":
		return c.canvasesViewSet(payload)
	case "canvases.linkPreview":
		return c.canvasesLinkPreview(payload)
	case "noteInk.list":
		return c.noteInkList(payload)
	case "noteInk.upsert":
		return c.noteInkUpsert(payload)
	case "noteInk.delete":
		return c.noteInkDelete(payload)
	case "imports.files.scan":
		return c.importFilesScan(payload)
	case "imports.files.run":
		return c.importFilesRun(payload)
	case "export.capabilities":
		return c.exportCapabilities()
	case "export.destinations.list":
		return c.exportDestinationsList()
	case "export.destinations.save":
		return c.exportDestinationsSave(payload)
	case "export.destinations.delete":
		return c.exportDestinationsDelete(payload)
	case "export.destinations.run":
		return c.exportDestinationsRun(payload)
	case "export.destinations.check":
		return c.exportDestinationsCheck(payload)
	case "export.destinations.takeOver":
		return c.exportDestinationsTakeOver(payload)
	case "export.destinations.setEnabled":
		return c.exportDestinationsSetEnabled(payload)
	case "export.sshKey.generate":
		return c.exportSSHKeyGenerate()
	case "export.sshKey.discard":
		return c.exportSSHKeyDiscard(payload)
	case "onboarding.list":
		return c.onboardingList()
	case "onboarding.record":
		return c.onboardingRecord(payload)
	case "onboarding.reset":
		return c.onboardingReset(payload)
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
