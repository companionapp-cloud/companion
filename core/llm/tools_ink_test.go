//go:build !js

package llm

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"

	"companion/core/ink"
	"companion/core/store"
)

// penGroup is a stored ink group with one horizontal pen stroke from (x, y), 40px long.
func penGroup(anchor string, x, y int) json.RawMessage {
	pts := []int{x * 10, y * 10, 50, 400, 0, 0}
	b, _ := json.Marshal(pts)
	return json.RawMessage(`{"v":1,"anchor":` + anchor + `,"strokes":[{"id":"s","tool":"pen","color":"ink","width":4,"points":` + string(b) + `}]}`)
}

// fakeRecognizer answers every image with one line covering the whole image.
type fakeRecognizer struct {
	texts []string
	calls int
}

func (f *fakeRecognizer) RecognizeInk(_ context.Context, images [][]byte) ([][]ink.Line, error) {
	f.calls++
	out := make([][]ink.Line, len(images))
	for i := range images {
		out[i] = []ink.Line{{Text: f.texts[i%len(f.texts)], Confidence: 0.9, Box: ink.Box{X: 0, Y: 0, W: 1, H: 1}}}
	}
	return out, nil
}

func TestInkToolsOnNote(t *testing.T) {
	s := newTestStore(t)
	note, err := s.Notes.Create(store.CreateNoteInput{Title: "Shopping", ContentMD: "Buy milk and eggs.\nCall mom."})
	if err != nil {
		t.Fatal(err)
	}
	over, beside := uuid.NewString(), uuid.NewString()
	if _, err := s.NoteInk.UpsertMany(note.ID, []store.NoteInkInput{
		{ID: over, Data: penGroup(`{"before":"Buy milk","after":" and eggs.","offset":8}`, 0, 0)},
		{ID: beside, Data: penGroup(`{"before":"Call mom.","after":"","offset":28,"free":true}`, 0, 0)},
	}); err != nil {
		t.Fatal(err)
	}
	rec := &fakeRecognizer{texts: []string{"oat", "re: birthday"}}
	r := NewStoreRegistry(s, WithInkRecognizer(rec))
	ctx := context.Background()

	// get_note says there is ink.
	out, err := r.Invoke(ctx, "get_note", json.RawMessage(`{"id":"`+note.ID+`"}`))
	if err != nil || !strings.Contains(out, `"inkGroups":2`) {
		t.Fatalf("get_note = %s, %v", out, err)
	}

	// read_ink: one PNG per group, and the groups' context in the text.
	rich, err := r.InvokeRich(ctx, "read_ink", json.RawMessage(`{"noteId":"`+note.ID+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(rich.Images) != 2 || rich.Images[0].MIMEType != "image/png" || !strings.HasPrefix(string(rich.Images[0].Data), "\x89PNG") {
		t.Fatalf("images = %d", len(rich.Images))
	}
	if !strings.Contains(rich.Text, `"kind":"over_text"`) || !strings.Contains(rich.Text, `"kind":"beside_line"`) {
		t.Errorf("read_ink text = %s", rich.Text)
	}

	// transcribe_ink: one transcript per group.
	out, err = r.Invoke(ctx, "transcribe_ink", json.RawMessage(`{"noteId":"`+note.ID+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	var tr struct {
		Transcripts []ink.Transcript `json:"transcripts"`
	}
	if err := json.Unmarshal([]byte(out), &tr); err != nil || len(tr.Transcripts) != 2 || rec.calls != 1 {
		t.Fatalf("transcribe_ink = %s (calls %d)", out, rec.calls)
	}

	// convert_ink_to_text: text lands where the ink was and the ink is erased.
	items, _ := json.Marshal(map[string]any{"noteId": note.ID, "items": []map[string]any{
		{"groupIds": []string{over}, "text": "oat"},
		{"groupIds": []string{beside}, "text": "re: birthday"},
	}})
	if _, err := r.Invoke(ctx, "convert_ink_to_text", items); err != nil {
		t.Fatal(err)
	}
	n, _ := s.Notes.Get(note.ID)
	if n.ContentMD != "Buy milk oat and eggs.\nCall mom.\n\nre: birthday" {
		t.Errorf("content = %q", n.ContentMD)
	}
	if left, _ := s.NoteInk.ListForNote(note.ID); len(left) != 0 {
		t.Errorf("%d ink groups left", len(left))
	}
	if !r.IsWrite("convert_ink_to_text") || r.IsWrite("read_ink") {
		t.Error("write flags wrong")
	}
}

func TestConvertInkOnPageAppendsInSheetOrder(t *testing.T) {
	s := newTestStore(t)
	nb, err := s.Notebooks.Create(store.CreateNotebookInput{Title: "Journal"})
	if err != nil {
		t.Fatal(err)
	}
	page, err := s.NotebookPages.Add(store.AddPageInput{NotebookID: nb.ID})
	if err != nil {
		t.Fatal(err)
	}
	top, bottom := uuid.NewString(), uuid.NewString()
	pageAnchor := `{"before":"","after":"","offset":0,"page":true}`
	if _, err := s.NotebookInk.UpsertMany(nb.ID, page.ID, []store.NoteInkInput{
		{ID: bottom, Data: penGroup(pageAnchor, 10, 300)},
		{ID: top, Data: penGroup(pageAnchor, 10, 20)},
	}); err != nil {
		t.Fatal(err)
	}
	r := NewStoreRegistry(s)
	if _, ok := r.tools["transcribe_ink"]; ok {
		t.Error("transcribe_ink registered without a recognizer")
	}
	// One image of the whole sheet.
	rich, err := r.InvokeRich(context.Background(), "read_ink", json.RawMessage(`{"pageId":"`+page.ID+`"}`))
	if err != nil || len(rich.Images) != 1 {
		t.Fatalf("read_ink page: %d images, %v", len(rich.Images), err)
	}
	items, _ := json.Marshal(map[string]any{"pageId": page.ID, "items": []map[string]any{
		{"groupIds": []string{bottom}, "text": "second"},
		{"groupIds": []string{top}, "text": "first"},
	}})
	if _, err := r.Invoke(context.Background(), "convert_ink_to_text", items); err != nil {
		t.Fatal(err)
	}
	p, _ := s.NotebookPages.Get(page.ID)
	if p.ContentMD != "first\n\nsecond" {
		t.Errorf("page content = %q", p.ContentMD)
	}
	// A group from somewhere else is refused.
	bad, _ := json.Marshal(map[string]any{"pageId": page.ID, "items": []map[string]any{{"groupIds": []string{top}, "text": "x"}}})
	if _, err := r.Invoke(context.Background(), "convert_ink_to_text", bad); err == nil {
		t.Error("converting an erased group should fail")
	}
}
