// Package sync is the client-side sync engine, shared by every platform (PLAN §5).
// It pushes dirty rows, then pulls server changes, resolving conflicts by the rule
// "server wins only if it's newer" and preserving losing local edits as conflicted
// copies. Only the HTTP transport is injected; the logic is identical everywhere.
package sync

import (
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

// Engine runs the sync loop against a local store and a transport.
type Engine struct {
	store     *store.Store
	transport Transport
	clock     domain.Clock
	pullLimit int
}

// New builds an Engine. A nil clock defaults to the system clock.
func New(st *store.Store, t Transport, clock domain.Clock) *Engine {
	if clock == nil {
		clock = domain.SystemClock{}
	}
	return &Engine{store: st, transport: t, clock: clock, pullLimit: 500}
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
	dirty, err := e.store.Notes.Dirty()
	if err != nil {
		return err
	}
	if len(dirty) == 0 {
		return nil
	}
	changes := make([]protocol.PushChange, 0, len(dirty))
	for _, n := range dirty {
		changes = append(changes, protocol.PushChange{
			EntityType:  protocol.EntityNote,
			ID:          n.ID,
			BaseVersion: n.Version,
			Row:         *n,
			UpdatedAt:   n.UpdatedAt,
		})
	}
	resp, err := e.transport.Push(changes)
	if err != nil {
		return err
	}
	for _, r := range resp.Results {
		switch r.Status {
		case "accepted":
			if err := e.store.Notes.MarkPushed(r.ID, r.Version); err != nil {
				return err
			}
		case "conflict":
			// The server kept its (newer) row. Adopt it locally; fork our losing
			// edit into a conflicted copy if it differed meaningfully.
			if r.ServerRow == nil {
				continue
			}
			local, err := e.store.Notes.GetAny(r.ID)
			if err != nil && !errors.Is(err, store.ErrNotFound) {
				return err
			}
			if err := e.serverWins(local, r.ServerRow); err != nil {
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
			if err := e.applyPulled(&resp.Changes[i].Row); err != nil {
				return err
			}
		}
		// Advance the cursor only after the batch is applied (§5.1).
		cursor = resp.NextCursor
		if err := e.store.SetCursor(cursor, e.clock.Now()); err != nil {
			return err
		}
		if len(resp.Changes) < e.pullLimit {
			return nil
		}
	}
}

// applyPulled reconciles one incoming server row with the local copy.
func (e *Engine) applyPulled(serverRow *domain.Note) error {
	local, err := e.store.Notes.GetAny(serverRow.ID)
	if errors.Is(err, store.ErrNotFound) {
		return e.store.Notes.Apply(serverRow)
	}
	if err != nil {
		return err
	}
	if !local.Dirty {
		return e.store.Notes.Apply(serverRow)
	}
	// Local has unpushed edits: conflict. Server wins only if it is at least as new.
	if !serverRow.UpdatedAt.Before(local.UpdatedAt) {
		return e.serverWins(local, serverRow)
	}
	// Client is newer — keep the dirty local row; it re-pushes next cycle and the
	// server accepts it (client newer). The loop converges (§5.4).
	return nil
}

// serverWins overwrites local with the server row, forking a conflicted copy of the
// losing local edit when it differed in meaningful fields.
func (e *Engine) serverWins(local, serverRow *domain.Note) error {
	if local != nil && meaningfulDiff(local, serverRow) {
		if _, err := e.store.Notes.CreateConflictedCopy(local, conflictedSuffix(e.clock.Now())); err != nil {
			return err
		}
	}
	return e.store.Notes.Apply(serverRow)
}

// meaningfulDiff reports whether two notes differ in user content (not just
// timestamps/version), including deleted-vs-alive.
func meaningfulDiff(a, b *domain.Note) bool {
	if a.Title != b.Title || a.ContentMD != b.ContentMD {
		return true
	}
	if derefStr(a.Date) != derefStr(b.Date) {
		return true
	}
	return (a.DeletedAt == nil) != (b.DeletedAt == nil)
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func conflictedSuffix(now time.Time) string {
	return "(conflicted copy " + now.UTC().Format("2006-01-02") + ")"
}
