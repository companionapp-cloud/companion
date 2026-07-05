package store

import "companion/core/domain"

// Held-note conflict interception (editor UX). While a note is open in an editor the UI
// "holds" it. If the sync engine then pulls a conflicting server version of that note
// (§7.3), it stashes it here instead of silently forking a conflicted copy, so the user
// can choose how to resolve — discard their edits, keep them as a new note, or restore a
// remotely-deleted note. Only the held note is intercepted; every other note reconciles
// through the engine's normal auto-fork path.

// Hold marks a note as open for editing so a conflicting server version is deferred to the
// UI. It replaces any previously held note and clears a stale stashed conflict.
func (r *NotesRepo) Hold(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.heldID = id
	r.heldConflict = nil
}

// Release stops holding a note (the editor closed). Any unresolved stashed conflict is
// dropped; its row is still the local dirty copy and reconciles normally next sync.
func (r *NotesRepo) Release() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.heldID = ""
	r.heldConflict = nil
}

// ShouldHold reports whether the given note id is the one currently held open, so the sync
// engine knows to stash rather than auto-fork its conflicts. Part of the engine's optional
// conflict-holder seam (core/sync).
func (r *NotesRepo) ShouldHold(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.heldID != "" && r.heldID == id
}

// StashHeldConflict records the losing server row for the held note so the UI can resolve
// it. Called by the sync engine in place of the auto-fork when ShouldHold is true. A
// non-note or non-held row is ignored.
func (r *NotesRepo) StashHeldConflict(server domain.SyncEntity) error {
	n, ok := server.(*domain.Note)
	if !ok {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.heldID != "" && r.heldID == n.ID {
		r.heldConflict = n
	}
	return nil
}

// PendingConflict returns the stashed server row awaiting UI resolution for the held note,
// or nil if there is none.
func (r *NotesRepo) PendingConflict() *domain.Note {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.heldConflict
}

// heldConflictID returns the held note's id when it has an unresolved stashed conflict, so
// Dirty can exclude it from pushes (a pending conflict must not keep re-pushing and
// re-conflicting until the user decides). Empty otherwise.
func (r *NotesRepo) heldConflictID() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.heldConflict != nil {
		return r.heldID
	}
	return ""
}

// takeConflict atomically reads and clears the stashed conflict for id, returning it (or
// nil if none matches). Used by the resolve paths so the db work happens outside the lock.
func (r *NotesRepo) takeConflict(id string) *domain.Note {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.heldConflict == nil || r.heldConflict.ID != id {
		return nil
	}
	c := r.heldConflict
	r.heldConflict = nil
	return c
}

// ResolveConflictAdopt discards the local edits and adopts the stashed server version
// (whatever it is — an edit, or a delete the user accepts). Returns ErrNotFound if there
// is no pending conflict for id.
func (r *NotesRepo) ResolveConflictAdopt(id string) error {
	server := r.takeConflict(id)
	if server == nil {
		return ErrNotFound
	}
	return r.Apply(server)
}

// ResolveConflictRestore resurrects a note the server deleted out from under the editor:
// it adopts the server row, then clears the delete so the note is live again and the
// resurrection syncs and wins. Returns ErrNotFound if there is no pending conflict for id.
func (r *NotesRepo) ResolveConflictRestore(id string) error {
	server := r.takeConflict(id)
	if server == nil {
		return ErrNotFound
	}
	if err := r.Apply(server); err != nil {
		return err
	}
	return r.Restore(id)
}
