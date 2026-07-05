// Package sync is the client-side sync engine, shared by every platform (PLAN §7).
// It pushes dirty rows, then pulls server changes, resolving conflicts by the rule
// "server wins only if it's newer" and preserving losing local edits as conflicted
// copies. The reconcile logic is written once and runs over every entity type through
// the generic SyncableRepo seam; only the HTTP transport is injected.
package sync

import (
	"encoding/json"
	"errors"
	"time"

	"companion/core/domain"
	"companion/core/store"
	"companion/core/sync/protocol"
)

// Transport is the injected network layer (net/http natively, fetch on wasm).
type Transport interface {
	Push(changes []protocol.PushChange) (*protocol.PushResponse, error)
	Pull(cursor int64, limit int) (*protocol.PullResponse, error)
}

// SyncableRepo is what the engine needs from each entity's repository. Every syncable
// repo (notes, areas, projects, project members, …) satisfies it structurally; the
// generic repoSyncer below turns it into a type-erased entitySyncer the engine holds.
type SyncableRepo[T domain.SyncEntity] interface {
	// EntityType is the wire tag (protocol.Entity*).
	EntityType() string
	// Dirty returns locally-changed rows (incl. tombstones), oldest-first, to push.
	Dirty() ([]T, error)
	// GetAny returns a row by id regardless of deleted state, or store.ErrNotFound.
	GetAny(id string) (T, error)
	// Apply overwrites the local row with a server-canonical one and clears dirty.
	Apply(row T) error
	// MarkPushed clears dirty and records the server version after a push.
	MarkPushed(id string, version int64) error
	// ConflictedCopy forks a losing local row into a fresh row (no-op for edge tables
	// with no meaningful content). Only called when MeaningfulDiff reported true.
	ConflictedCopy(local T, suffix string) error
	// MeaningfulDiff reports whether two rows differ in user content (not just
	// timestamps/version), including alive-vs-deleted.
	MeaningfulDiff(a, b T) bool
	// Decode unmarshals a wire row body into a concrete entity.
	Decode(raw json.RawMessage) (T, error)
}

// entitySyncer is the type-erased façade the engine iterates over.
type entitySyncer interface {
	entityType() string
	collectDirty() ([]protocol.PushChange, error)
	applyPulled(raw json.RawMessage) error
	resolveConflict(serverRaw json.RawMessage) error
	markPushed(id string, version int64) error
}

// repoSyncer adapts a typed SyncableRepo[T] to entitySyncer, centralizing the
// push/pull/conflict logic once for every entity type.
type repoSyncer[T domain.SyncEntity] struct {
	repo  SyncableRepo[T]
	clock domain.Clock
}

func newRepoSyncer[T domain.SyncEntity](repo SyncableRepo[T], clock domain.Clock) *repoSyncer[T] {
	return &repoSyncer[T]{repo: repo, clock: clock}
}

func (s *repoSyncer[T]) entityType() string { return s.repo.EntityType() }

func (s *repoSyncer[T]) collectDirty() ([]protocol.PushChange, error) {
	dirty, err := s.repo.Dirty()
	if err != nil {
		return nil, err
	}
	out := make([]protocol.PushChange, 0, len(dirty))
	for _, row := range dirty {
		raw, err := json.Marshal(row)
		if err != nil {
			return nil, err
		}
		out = append(out, protocol.PushChange{
			EntityType:  s.repo.EntityType(),
			ID:          row.SyncID(),
			BaseVersion: row.SyncVersion(),
			Row:         raw,
			UpdatedAt:   row.SyncUpdatedAt(),
		})
	}
	return out, nil
}

func (s *repoSyncer[T]) markPushed(id string, version int64) error {
	return s.repo.MarkPushed(id, version)
}

// applyPulled reconciles one incoming server row with the local copy (§7.1).
func (s *repoSyncer[T]) applyPulled(raw json.RawMessage) error {
	server, err := s.repo.Decode(raw)
	if err != nil {
		return err
	}
	local, err := s.repo.GetAny(server.SyncID())
	if errors.Is(err, store.ErrNotFound) {
		return s.repo.Apply(server)
	}
	if err != nil {
		return err
	}
	if !local.SyncDirty() {
		return s.repo.Apply(server)
	}
	// Local has unpushed edits: conflict. Server wins only if it is at least as new.
	if !server.SyncUpdatedAt().Before(local.SyncUpdatedAt()) {
		return s.serverWins(local, server)
	}
	// Client is newer — keep the dirty local row; it re-pushes next cycle and the
	// server accepts it (client newer). The loop converges (§7.4).
	return nil
}

// resolveConflict handles a push 'conflict' result: the server kept its (newer) row.
func (s *repoSyncer[T]) resolveConflict(serverRaw json.RawMessage) error {
	server, err := s.repo.Decode(serverRaw)
	if err != nil {
		return err
	}
	local, err := s.repo.GetAny(server.SyncID())
	if errors.Is(err, store.ErrNotFound) {
		return s.repo.Apply(server)
	}
	if err != nil {
		return err
	}
	return s.serverWins(local, server)
}

// conflictHolder is an optional seam a repo may implement to intercept conflicts for a
// row the UI holds open (e.g. a note in an editor). When ShouldHold reports the row is
// held, the engine stashes the losing server version for the UI to resolve instead of
// auto-forking a conflicted copy — letting the user choose discard / keep-as-copy /
// restore. Only the notes repo implements it; every other entity forks as usual.
type conflictHolder interface {
	ShouldHold(id string) bool
	StashHeldConflict(server domain.SyncEntity) error
}

// serverWins overwrites local with the server row, forking a conflicted copy of the
// losing local edit when it differed in meaningful fields (§7.3). If the row is held open
// by the UI, the conflict is instead stashed for interactive resolution and the local
// edit is left untouched.
func (s *repoSyncer[T]) serverWins(local, server T) error {
	if h, ok := any(s.repo).(conflictHolder); ok && h.ShouldHold(server.SyncID()) {
		return h.StashHeldConflict(server)
	}
	if s.repo.MeaningfulDiff(local, server) {
		if err := s.repo.ConflictedCopy(local, conflictedSuffix(s.clock.Now())); err != nil {
			return err
		}
	}
	return s.repo.Apply(server)
}

// Engine runs the sync loop against a local store and a transport.
type Engine struct {
	store     *store.Store
	transport Transport
	clock     domain.Clock
	pullLimit int
	syncers   []entitySyncer
	byType    map[string]entitySyncer
}

// New builds an Engine wired to every syncable entity. A nil clock defaults to the
// system clock.
func New(st *store.Store, t Transport, clock domain.Clock) *Engine {
	if clock == nil {
		clock = domain.SystemClock{}
	}
	e := &Engine{store: st, transport: t, clock: clock, pullLimit: 500, byType: map[string]entitySyncer{}}
	// Push/pull order across types follows registration; foreign-key-ish dependencies
	// (a project's area, a member's project) are tolerated because dangling references
	// are expected and resolve as rows arrive (PLAN §5.1, §6.6).
	e.register(newRepoSyncer[*domain.Note](st.Notes, clock))
	e.register(newRepoSyncer[*domain.Task](st.Tasks, clock))
	e.register(newRepoSyncer[*domain.Area](st.Areas, clock))
	e.register(newRepoSyncer[*domain.Project](st.Projects, clock))
	e.register(newRepoSyncer[*domain.ProjectMember](st.ProjectMembers, clock))
	return e
}

func (e *Engine) register(s entitySyncer) {
	e.syncers = append(e.syncers, s)
	e.byType[s.entityType()] = s
}

// Sync runs one full cycle: push first (may generate conflicts whose canonical rows
// arrive in the following pull), then pull.
func (e *Engine) Sync() error {
	if err := e.push(); err != nil {
		return err
	}
	return e.pull()
}

func (e *Engine) push() error {
	var changes []protocol.PushChange
	for _, s := range e.syncers {
		d, err := s.collectDirty()
		if err != nil {
			return err
		}
		changes = append(changes, d...)
	}
	if len(changes) == 0 {
		return nil
	}
	resp, err := e.transport.Push(changes)
	if err != nil {
		return err
	}
	// Results come back in request order (the server appends one per change), so
	// results[i] belongs to changes[i] and thus its entity type.
	for i, r := range resp.Results {
		if i >= len(changes) {
			break
		}
		syncer := e.byType[changes[i].EntityType]
		if syncer == nil {
			continue
		}
		switch r.Status {
		case protocol.StatusAccepted:
			if err := syncer.markPushed(r.ID, r.Version); err != nil {
				return err
			}
		case protocol.StatusConflict:
			if len(r.ServerRow) == 0 {
				continue
			}
			if err := syncer.resolveConflict(r.ServerRow); err != nil {
				return err
			}
		}
	}
	return nil
}

func (e *Engine) pull() error {
	cursor, err := e.store.Cursor()
	if err != nil {
		return err
	}
	for {
		resp, err := e.transport.Pull(cursor, e.pullLimit)
		if err != nil {
			return err
		}
		for i := range resp.Changes {
			ch := &resp.Changes[i]
			syncer := e.byType[ch.EntityType]
			if syncer == nil {
				continue // unknown entity type from a newer server; skip (forward-compat)
			}
			if err := syncer.applyPulled(ch.Row); err != nil {
				return err
			}
		}
		// Advance the cursor only after the batch is applied (§7.1).
		cursor = resp.NextCursor
		if err := e.store.SetCursor(cursor, e.clock.Now()); err != nil {
			return err
		}
		if len(resp.Changes) < e.pullLimit {
			return nil
		}
	}
}

func conflictedSuffix(now time.Time) string {
	return "(conflicted copy " + now.UTC().Format("2006-01-02") + ")"
}
