//go:build !js

package store

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"companion/core/domain"
)

const (
	inkA = "0190f5a0-0000-7000-8000-00000000000a"
	inkB = "0190f5a0-0000-7000-8000-00000000000b"
)

func TestNoteInkUpsertListDelete(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)
	note, err := s.Notes.Create(CreateNoteInput{Title: "Sketches"})
	if err != nil {
		t.Fatalf("create note: %v", err)
	}

	// The editor picks the ids; groups list back in the order they were drawn.
	saved, err := s.NoteInk.UpsertMany(note.ID, []NoteInkInput{
		{ID: inkA, Data: json.RawMessage(`{"v":1,"strokes":[]}`)},
	})
	if err != nil || len(saved) != 1 || saved[0].ID != inkA || !saved[0].Dirty || saved[0].Version != 0 {
		t.Fatalf("upsert = %+v (err %v)", saved, err)
	}
	clk.t = clk.t.Add(time.Minute)
	if _, err := s.NoteInk.UpsertMany(note.ID, []NoteInkInput{{ID: inkB, Data: json.RawMessage(`{"v":1}`)}}); err != nil {
		t.Fatalf("upsert B: %v", err)
	}
	list, err := s.NoteInk.ListForNote(note.ID)
	if err != nil || len(list) != 2 || list[0].ID != inkA || list[1].ID != inkB {
		t.Fatalf("list = %+v (err %v)", list, err)
	}

	// Overwriting a group keeps its creation time and replaces the payload whole.
	created := list[0].CreatedAt
	clk.t = clk.t.Add(time.Minute)
	if _, err := s.NoteInk.UpsertMany(note.ID, []NoteInkInput{{ID: inkA, Data: json.RawMessage(`{"v":1,"strokes":[1]}`)}}); err != nil {
		t.Fatalf("overwrite: %v", err)
	}
	got, _ := s.NoteInk.GetAny(inkA)
	if !got.CreatedAt.Equal(created) || string(got.Data) != `{"v":1,"strokes":[1]}` || !got.UpdatedAt.Equal(clk.t) {
		t.Fatalf("overwrite = %+v", got)
	}

	// A group can't move to another note.
	other, _ := s.Notes.Create(CreateNoteInput{Title: "Other"})
	if _, err := s.NoteInk.UpsertMany(other.ID, []NoteInkInput{{ID: inkA, Data: json.RawMessage(`{}`)}}); !errors.Is(err, domain.ErrInvalidNoteInk) {
		t.Fatalf("cross-note upsert err = %v", err)
	}

	// Erasing tombstones the group dirty (so the delete syncs) and hides it.
	if n, err := s.NoteInk.DeleteMany([]string{inkA}); err != nil || n != 1 {
		t.Fatalf("delete = %d (err %v)", n, err)
	}
	gone, _ := s.NoteInk.GetAny(inkA)
	if gone.DeletedAt == nil || !gone.Dirty {
		t.Fatalf("tombstone not recorded: %+v", gone)
	}
	if list, _ := s.NoteInk.ListForNote(note.ID); len(list) != 1 || list[0].ID != inkB {
		t.Fatalf("list after delete = %+v", list)
	}

	// Undoing the erase upserts the same id again, which brings the group back.
	if _, err := s.NoteInk.UpsertMany(note.ID, []NoteInkInput{{ID: inkA, Data: json.RawMessage(`{"v":1}`)}}); err != nil {
		t.Fatalf("resurrect: %v", err)
	}
	if back, _ := s.NoteInk.GetAny(inkA); back.DeletedAt != nil {
		t.Fatalf("resurrected group still deleted: %+v", back)
	}

	// Purging the note tombstones all of its ink.
	if err := s.NoteInk.DeleteForNote(note.ID); err != nil {
		t.Fatalf("delete for note: %v", err)
	}
	if list, _ := s.NoteInk.ListForNote(note.ID); len(list) != 0 {
		t.Fatalf("ink survived its note: %+v", list)
	}
}

func TestNoteInkValidation(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)
	note, _ := s.Notes.Create(CreateNoteInput{Title: "n"})

	cases := map[string]NoteInkInput{
		"non-uuid id":   {ID: "stroke-1", Data: json.RawMessage(`{}`)},
		"empty id":      {ID: "", Data: json.RawMessage(`{}`)},
		"array payload": {ID: inkA, Data: json.RawMessage(`[1,2]`)},
		"oversized":     {ID: inkA, Data: json.RawMessage(`{"p":"` + string(make([]byte, domain.MaxNoteInkData)) + `"}`)},
	}
	for name, in := range cases {
		if _, err := s.NoteInk.UpsertMany(note.ID, []NoteInkInput{in}); !errors.Is(err, domain.ErrInvalidNoteInk) {
			t.Errorf("%s: err = %v, want ErrInvalidNoteInk", name, err)
		}
	}
}

func TestNoteInkSyncRepo(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)
	note, _ := s.Notes.Create(CreateNoteInput{Title: "n"})
	if _, err := s.NoteInk.UpsertMany(note.ID, []NoteInkInput{{ID: inkA, Data: json.RawMessage(`{"v":1}`)}}); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	dirty, err := s.NoteInk.Dirty()
	if err != nil || len(dirty) != 1 {
		t.Fatalf("dirty = %+v (err %v)", dirty, err)
	}
	if err := s.NoteInk.MarkPushed(inkA, 3); err != nil {
		t.Fatalf("mark pushed: %v", err)
	}
	if dirty, _ := s.NoteInk.Dirty(); len(dirty) != 0 {
		t.Fatalf("still dirty after push: %+v", dirty)
	}

	// A pulled group is applied clean at the server's version.
	pulled := &domain.NoteInk{ID: inkB, NoteID: note.ID, Data: json.RawMessage(`{"v":1,"from":"server"}`),
		CreatedAt: clk.t, UpdatedAt: clk.t, Version: 7}
	if err := s.NoteInk.Apply(pulled); err != nil {
		t.Fatalf("apply: %v", err)
	}
	got, _ := s.NoteInk.GetAny(inkB)
	if got.Dirty || got.Version != 7 || string(got.Data) != `{"v":1,"from":"server"}` {
		t.Fatalf("applied = %+v", got)
	}
	if s.NoteInk.MeaningfulDiff(got, pulled) {
		t.Fatalf("ink conflicts must be last-writer-wins")
	}
}
