package bridge

import (
	"encoding/json"
	"errors"
	"strings"

	"companion/core/store"
)

// noteInkChangedEvent signals an open note to reload its ink after a local write. Payload:
// {noteId}. Ink pulled by a sync arrives with the bulk data.changed that every sync emits.
// Ink writes deliberately skip data.changed: nothing else (graph, lists, canvases) shows ink,
// and a drawing burst would otherwise refresh all of them.
const noteInkChangedEvent = "noteInk.changed"

func (c *Core) emitNoteInkChanged(noteID string) {
	payload, _ := json.Marshal(map[string]string{"noteId": noteID})
	c.emit(noteInkChangedEvent, payload)
}

// noteInkList returns a note's live ink groups, in the order they were drawn.
func (c *Core) noteInkList(payload []byte) ([]byte, error) {
	var args struct {
		NoteID string `json:"noteId"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.NoteID) == "" {
		return nil, errors.New("noteId is required")
	}
	groups, err := c.store.NoteInk.ListForNote(args.NoteID)
	if err != nil {
		return nil, err
	}
	return json.Marshal(groups)
}

// noteInkUpsert creates or overwrites a batch of ink groups on a live note. The editor picks
// the ids and writes each group whole.
func (c *Core) noteInkUpsert(payload []byte) ([]byte, error) {
	var args struct {
		NoteID string               `json:"noteId"`
		Groups []store.NoteInkInput `json:"groups"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if _, err := c.store.Notes.Get(args.NoteID); err != nil {
		return nil, mapStoreErr(err)
	}
	groups, err := c.store.NoteInk.UpsertMany(args.NoteID, args.Groups)
	if err != nil {
		return nil, err
	}
	c.emitNoteInkChanged(args.NoteID)
	return json.Marshal(groups)
}

// noteInkDelete tombstones ink groups (an erase, or an undone stroke that made a group).
func (c *Core) noteInkDelete(payload []byte) ([]byte, error) {
	var args struct {
		NoteID string   `json:"noteId"`
		IDs    []string `json:"ids"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	n, err := c.store.NoteInk.DeleteMany(args.IDs)
	if err != nil {
		return nil, err
	}
	c.emitNoteInkChanged(args.NoteID)
	return json.Marshal(map[string]int64{"count": n})
}
