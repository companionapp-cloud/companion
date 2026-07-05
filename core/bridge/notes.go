package bridge

import (
	"encoding/json"

	"companion/core/domain"
	"companion/core/store"
)

// notesChanged is emitted whenever a note mutation succeeds so the UI can refresh
// (PLAN §3.1 "data changed" notifications).
const notesChangedEvent = "notes.changed"

// notesConflictEvent fires after a sync that stashed a conflicting server version for a
// note the UI holds open (see hold.go), so the open editor can prompt the user to resolve
// it. Payload: {id, deleted}.
const notesConflictEvent = "notes.conflict"

// noteConflictInfo is the wire shape of a pending held-note conflict.
func noteConflictInfo(n *domain.Note) map[string]any {
	return map[string]any{"id": n.ID, "deleted": n.DeletedAt != nil || n.DeletingAt != nil}
}

func (c *Core) notesList() ([]byte, error) {
	notes, err := c.store.Notes.List()
	if err != nil {
		return nil, err
	}
	return json.Marshal(notes)
}

func (c *Core) notesGet(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	n, err := c.store.Notes.Get(args.ID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	return json.Marshal(n)
}

func (c *Core) notesCreate(payload []byte) ([]byte, error) {
	var in store.CreateNoteInput
	if err := unmarshal(payload, &in); err != nil {
		return nil, err
	}
	n, err := c.store.Notes.Create(in)
	if err != nil {
		return nil, err
	}
	c.emit(notesChangedEvent, nil)
	c.emitDataChanged("note", n.ID)
	return json.Marshal(n)
}

func (c *Core) notesUpdate(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
		store.UpdateNoteInput
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	n, err := c.store.Notes.Update(args.ID, args.UpdateNoteInput)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	c.emit(notesChangedEvent, nil)
	c.emitDataChanged("note", n.ID)
	return json.Marshal(n)
}

// notesDelete moves a note to the Trash (PLAN §4.3) rather than tombstoning it outright:
// it lingers for 30 days, recoverable from the Trash, until the server's collector purges
// it. "Delete forever" and "Restore" go through the trash.* methods (see trash.go).
func (c *Core) notesDelete(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if err := c.store.Notes.Trash(args.ID); err != nil {
		return nil, mapStoreErr(err)
	}
	c.emit(notesChangedEvent, nil)
	c.emitDataChanged("note", args.ID)
	return json.Marshal(map[string]bool{"ok": true})
}

// notesHold marks a note as open in an editor so the sync engine defers a conflicting
// server version to the UI instead of auto-forking it (see hold.go).
func (c *Core) notesHold(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	c.store.Notes.Hold(args.ID)
	return json.Marshal(map[string]bool{"ok": true})
}

// notesRelease stops holding the open note (editor closed).
func (c *Core) notesRelease() ([]byte, error) {
	c.store.Notes.Release()
	return json.Marshal(map[string]bool{"ok": true})
}

// notesConflict returns the pending held-note conflict ({id, deleted}) awaiting the user's
// decision, or null when there is none.
func (c *Core) notesConflict() ([]byte, error) {
	pc := c.store.Notes.PendingConflict()
	if pc == nil {
		return json.Marshal(nil)
	}
	return json.Marshal(noteConflictInfo(pc))
}

// notesConflictResolve applies the user's decision to a held-note conflict: "adopt" takes
// the server version (discarding the local edit — or accepting the delete); "restore"
// resurrects a remotely-deleted note. Saving the local edit as a new note is a plain
// notes.create the UI issues first, so it isn't modelled here.
func (c *Core) notesConflictResolve(payload []byte) ([]byte, error) {
	var args struct {
		ID     string `json:"id"`
		Action string `json:"action"` // "adopt" | "restore"
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	var err error
	switch args.Action {
	case "restore":
		err = c.store.Notes.ResolveConflictRestore(args.ID)
	default:
		err = c.store.Notes.ResolveConflictAdopt(args.ID)
	}
	if err != nil {
		return nil, mapStoreErr(err)
	}
	c.emit(notesChangedEvent, nil)
	c.emitDataChanged("note", args.ID)
	return json.Marshal(map[string]bool{"ok": true})
}
