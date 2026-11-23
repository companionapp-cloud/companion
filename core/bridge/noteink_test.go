package bridge

import (
	"context"
	"encoding/json"
	"testing"

	"companion/core/agents"
	"companion/core/domain"
	"companion/core/ink"
	"companion/core/llm"
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

// inkFoundation stands in for the desktop's on-device helper: a model host that also reads
// handwriting.
type inkFoundation struct{}

func (inkFoundation) Provider(agents.FoundationOptions) llm.Provider { return nil }

func (inkFoundation) RecognizeInk(_ context.Context, images [][]byte) ([][]ink.Line, error) {
	out := make([][]ink.Line, len(images))
	for i := range images {
		out[i] = []ink.Line{{Text: "hello", Confidence: 1, Box: ink.Box{W: 1, H: 1}}}
	}
	return out, nil
}

func TestNoteInkTranscribe(t *testing.T) {
	c, _ := newTestCore(t)
	if got := invoke[map[string]bool](t, c, "noteInk.canTranscribe", map[string]any{}); got["available"] {
		t.Fatal("transcription available without a recognizer")
	}
	note := invoke[domain.Note](t, c, "notes.create", map[string]string{"title": "Ink", "contentMd": "hi"})
	pen := map[string]any{"v": 1, "anchor": map[string]any{"before": "hi", "after": "", "offset": 2, "free": true},
		"strokes": []any{map[string]any{"id": "s", "tool": "pen", "color": "ink", "width": 4, "points": []int{0, 0, 50, 300, 0, 0}}}}
	invoke[[]domain.NoteInk](t, c, "noteInk.upsert", map[string]any{"noteId": note.ID, "groups": []map[string]any{{"id": bridgeInkID, "data": pen}}})
	payload, _ := json.Marshal(map[string]string{"noteId": note.ID})
	if _, err := c.Invoke("noteInk.transcribe", payload); err == nil {
		t.Fatal("transcribe without a recognizer should fail")
	}

	c.SetFoundationModels(inkFoundation{})
	if got := invoke[map[string]bool](t, c, "noteInk.canTranscribe", map[string]any{}); !got["available"] {
		t.Fatal("transcription unavailable with a recognizer")
	}
	got := invoke[struct {
		Transcripts []ink.Transcript `json:"transcripts"`
	}](t, c, "noteInk.transcribe", map[string]string{"noteId": note.ID})
	if len(got.Transcripts) != 1 || got.Transcripts[0].Text != "hello" || got.Transcripts[0].GroupIDs[0] != bridgeInkID {
		t.Fatalf("transcripts = %+v", got.Transcripts)
	}
	// Reading leaves the note and its ink alone: the editor does the converting.
	if n := invoke[domain.Note](t, c, "notes.get", map[string]string{"id": note.ID}); n.ContentMD != "hi" {
		t.Errorf("content changed to %q", n.ContentMD)
	}
}

// A page's ink is read as one image of the sheet, and the lines map back to its groups.
func TestNotebookInkTranscribe(t *testing.T) {
	c, _ := newTestCore(t)
	c.SetFoundationModels(inkFoundation{})
	nb := invoke[domain.Notebook](t, c, "notebooks.create", map[string]string{"title": "Journal"})
	doc := invoke[notebookDocument](t, c, "notebooks.get", map[string]string{"id": nb.ID})
	page := doc.Pages[0]
	pen := map[string]any{"v": 1, "anchor": map[string]any{"before": "", "after": "", "offset": 0, "page": true},
		"strokes": []any{map[string]any{"id": "s", "tool": "pen", "color": "ink", "width": 4, "points": []int{400, 600, 50, 300, 0, 0}}}}
	invoke[[]domain.NotebookPageInk](t, c, "notebooks.ink.upsert", map[string]any{"pageId": page.ID, "groups": []map[string]any{{"id": bridgeInkID, "data": pen}}})
	got := invoke[struct {
		Transcripts []ink.Transcript `json:"transcripts"`
	}](t, c, "notebooks.ink.transcribe", map[string]string{"pageId": page.ID})
	if len(got.Transcripts) != 1 || got.Transcripts[0].GroupIDs[0] != bridgeInkID || got.Transcripts[0].Text != "hello" {
		t.Fatalf("transcripts = %+v", got.Transcripts)
	}
}
