package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"companion/core/ink"
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

// noteInkTranscribe reads the handwriting on a note with this device's recognizer, for the
// drawing bar's "Convert to text". It only reads: the editor puts the text in place and erases
// the ink itself, so the open note stays the one source of its own content.
func (c *Core) noteInkTranscribe(payload []byte) ([]byte, error) {
	var args struct {
		NoteID   string   `json:"noteId"`
		GroupIDs []string `json:"groupIds"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	rows, err := c.store.NoteInk.ListForNote(args.NoteID)
	if err != nil {
		return nil, err
	}
	stored := make([]storedInk, len(rows))
	for i, r := range rows {
		stored[i] = storedInk{r.ID, r.Data}
	}
	return c.transcribeInk(stored, args.GroupIDs, false)
}

// notebooksInkTranscribe is noteInkTranscribe for a notebook page. A page's groups share the
// sheet's coordinates, so they are read as one image of the page.
func (c *Core) notebooksInkTranscribe(payload []byte) ([]byte, error) {
	var args struct {
		PageID   string   `json:"pageId"`
		GroupIDs []string `json:"groupIds"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	rows, err := c.store.NotebookInk.ListForPage(args.PageID)
	if err != nil {
		return nil, err
	}
	stored := make([]storedInk, len(rows))
	for i, r := range rows {
		stored[i] = storedInk{r.ID, r.Data}
	}
	return c.transcribeInk(stored, args.GroupIDs, true)
}

type storedInk struct {
	id   string
	data json.RawMessage
}

// transcribeInk reads the writing in stored ink groups (only groupIDs, when given).
func (c *Core) transcribeInk(rows []storedInk, groupIDs []string, shared bool) ([]byte, error) {
	rec := c.inkRecognizer()
	if rec == nil {
		return nil, errors.New("handwriting recognition isn't available on this device")
	}
	want := map[string]bool{}
	for _, id := range groupIDs {
		want[id] = true
	}
	var groups []*ink.Group
	for _, r := range rows {
		if len(want) > 0 && !want[r.id] {
			continue
		}
		g, err := ink.Parse(r.id, r.data)
		if err != nil || !g.Writing() {
			continue
		}
		groups = append(groups, g)
	}
	transcripts, unread, err := ink.Transcribe(context.Background(), rec, groups, shared)
	if err != nil {
		return nil, err
	}
	if unread == nil {
		unread = []string{}
	}
	return json.Marshal(map[string]any{"transcripts": transcripts, "unread": unread})
}
