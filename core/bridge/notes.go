package bridge

import (
	"encoding/json"

	"companion/core/store"
)

// notesChanged is emitted whenever a note mutation succeeds so the UI can refresh
// (PLAN §3.1 "data changed" notifications).
const notesChangedEvent = "notes.changed"

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

func (c *Core) notesDelete(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if err := c.store.Notes.Delete(args.ID); err != nil {
		return nil, mapStoreErr(err)
	}
	c.emit(notesChangedEvent, nil)
	c.emitDataChanged("note", args.ID)
	return json.Marshal(map[string]bool{"ok": true})
}
