package bridge

import (
	"encoding/json"
	"testing"

	"companion/core/domain"
)

const bridgeInkID = "0190f5a0-0000-7000-8000-0000000000c1"

// Ink round-trips through the bridge, survives its note's trip through the Trash, and is
// tombstoned when the note is deleted forever (PLAN-drawing.md).
func TestNoteInkOverBridge(t *testing.T) {
	c, h := newTestCore(t)
	note := invoke[domain.Note](t, c, "notes.create", map[string]string{"title": "Sketch", "contentMd": "hello"})

	saved := invoke[[]domain.NoteInk](t, c, "noteInk.upsert", map[string]any{
		"noteId": note.ID,
		"groups": []map[string]any{{"id": bridgeInkID, "data": map[string]any{"v": 1, "strokes": []any{}}}},
	})
	if len(saved) != 1 || saved[0].NoteID != note.ID {
		t.Fatalf("upsert = %+v", saved)
	}
	if h.count(noteInkChangedEvent) != 1 {
		t.Fatalf("noteInk.changed emitted %d times, want 1", h.count(noteInkChangedEvent))
	}
	if h.count("data.changed") != 1 { // only the note create; ink writes skip data.changed
		t.Fatalf("data.changed emitted %d times, want 1 (the note create)", h.count("data.changed"))
	}

	// Ink can't be written to a note that doesn't exist.
	payload, _ := json.Marshal(map[string]any{"noteId": "missing", "groups": []map[string]any{{"id": bridgeInkID, "data": map[string]any{}}}})
	if _, err := c.Invoke("noteInk.upsert", payload); err == nil {
		t.Fatalf("upsert onto a missing note should fail")
	}

	// Trash keeps the ink (it comes back with the note on restore).
	invoke[map[string]bool](t, c, "notes.delete", map[string]string{"id": note.ID})
	if got := invoke[[]domain.NoteInk](t, c, "noteInk.list", map[string]string{"noteId": note.ID}); len(got) != 1 {
		t.Fatalf("trashing the note dropped its ink: %+v", got)
	}

	// Delete forever tombstones the ink with the note.
	invoke[map[string]bool](t, c, "trash.purge", map[string]string{"entityType": "note", "id": note.ID})
	if got := invoke[[]domain.NoteInk](t, c, "noteInk.list", map[string]string{"noteId": note.ID}); len(got) != 0 {
		t.Fatalf("ink outlived its purged note: %+v", got)
	}
	tomb, err := c.store.NoteInk.GetAny(bridgeInkID)
	if err != nil || tomb.DeletedAt == nil || !tomb.Dirty {
		t.Fatalf("purged ink should be a dirty tombstone: %+v (err %v)", tomb, err)
	}
}

func TestNoteInkDeleteOverBridge(t *testing.T) {
	c, _ := newTestCore(t)
	note := invoke[domain.Note](t, c, "notes.create", map[string]string{"title": "n"})
	invoke[[]domain.NoteInk](t, c, "noteInk.upsert", map[string]any{
		"noteId": note.ID,
		"groups": []map[string]any{{"id": bridgeInkID, "data": map[string]any{"v": 1}}},
	})
	res := invoke[map[string]int64](t, c, "noteInk.delete", map[string]any{"noteId": note.ID, "ids": []string{bridgeInkID}})
	if res["count"] != 1 {
		t.Fatalf("delete count = %d", res["count"])
	}
	if got := invoke[[]domain.NoteInk](t, c, "noteInk.list", map[string]string{"noteId": note.ID}); len(got) != 0 {
		t.Fatalf("deleted group still listed: %+v", got)
	}
}
