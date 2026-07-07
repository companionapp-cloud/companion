package main

import (
	"encoding/json"
	"testing"
	"time"

	"companion/core/domain"
	"companion/core/store"
)

// An object type and an archetyped note created on device A converge on device B, and B
// derives the same prop:<field> reference edge locally — proving object-type sync plus
// prop-edge extraction on sync-apply (PLAN §5.1, §6.3, §7).
func TestObjectTypesAndArchetypedNotesSync(t *testing.T) {
	ts := newServer(t)
	token := register(t, ts.URL, "obj@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	schema, _ := json.Marshal(domain.ObjectSchema{Fields: []domain.ObjectField{
		{Key: "author", Type: domain.FieldReference, To: domain.NodeNote},
		{Key: "status", Type: domain.FieldSelect, Options: []string{"to-read", "done"}, Required: true},
	}})
	ot, err := a.store.ObjectTypes.Create(store.CreateObjectTypeInput{
		Name: "Book", AppliesTo: domain.AppliesToNote, SchemaJSON: schema,
	})
	if err != nil {
		t.Fatalf("create object type: %v", err)
	}
	props, _ := json.Marshal(map[string]any{"author": "note-herbert", "status": "done"})
	note, err := a.store.Notes.Create(store.CreateNoteInput{
		Title: "Dune", ObjectTypeID: &ot.ID, Props: props,
	})
	if err != nil {
		t.Fatalf("create archetyped note: %v", err)
	}

	if err := a.engine.Sync(); err != nil {
		t.Fatalf("A sync: %v", err)
	}
	if err := b.engine.Sync(); err != nil {
		t.Fatalf("B sync: %v", err)
	}

	// B has the object type definition.
	gotType, err := b.store.ObjectTypes.Get(ot.ID)
	if err != nil || gotType.Name != "Book" || gotType.AppliesTo != domain.AppliesToNote {
		t.Fatalf("B object type = %+v (err %v)", gotType, err)
	}
	if gotType.Dirty || gotType.Version == 0 {
		t.Errorf("synced type should be clean with a server version: %+v", gotType)
	}

	// B has the archetyped note with its props intact.
	gotNote, err := b.store.Notes.Get(note.ID)
	if err != nil || gotNote.ObjectTypeID == nil || *gotNote.ObjectTypeID != ot.ID {
		t.Fatalf("B note archetype = %+v (err %v)", gotNote, err)
	}
	var gotProps map[string]any
	if err := json.Unmarshal(gotNote.Props, &gotProps); err != nil || gotProps["status"] != "done" {
		t.Fatalf("B note props = %s (err %v)", string(gotNote.Props), err)
	}

	// ...and B derived the same prop:author edge into its local link index.
	if !hasPropEdge(t, b, note.ID, "note-herbert", "prop:author") {
		t.Errorf("B did not derive the prop:author edge note=%s -> note-herbert", note.ID)
	}
}

// Archetyping a note that already exists and has already synced (the common real flow:
// open a plain note, set its object type) must survive the next sync cycle — the origin
// keeps the archetype through its own push+pull echo, and the other device receives it.
// Guards the "when sync updates the note, we lose the object change" report.
func TestArchetypeOnAlreadySyncedNoteSurvivesSync(t *testing.T) {
	ts := newServer(t)
	token := register(t, ts.URL, "arch@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	// A plain note and a type both exist and sync everywhere first.
	schema, _ := json.Marshal(domain.ObjectSchema{Fields: []domain.ObjectField{
		{Key: "status", Type: domain.FieldSelect, Options: []string{"to-read", "done"}},
	}})
	ot, err := a.store.ObjectTypes.Create(store.CreateObjectTypeInput{Name: "Book", AppliesTo: domain.AppliesToNote, SchemaJSON: schema})
	if err != nil {
		t.Fatalf("create type: %v", err)
	}
	note, err := a.store.Notes.Create(store.CreateNoteInput{Title: "Dune"})
	if err != nil {
		t.Fatalf("create note: %v", err)
	}
	syncAll(t, a, b)

	// Now archetype the existing note (a later write) and sync.
	a.clk.t = base.Add(time.Hour)
	props, _ := json.Marshal(map[string]any{"status": "done"})
	if _, err := a.store.Notes.Update(note.ID, store.UpdateNoteInput{
		ObjectTypeID: &ot.ID, Props: (*json.RawMessage)(&props),
	}); err != nil {
		t.Fatalf("archetype note: %v", err)
	}
	syncAll(t, a, b)

	// The origin device still shows the archetype after its own push + pull echo.
	gotA, err := a.store.Notes.Get(note.ID)
	if err != nil || gotA.ObjectTypeID == nil || *gotA.ObjectTypeID != ot.ID {
		t.Fatalf("A lost the archetype after sync: %+v (err %v)", gotA, err)
	}
	if gotA.Dirty {
		t.Errorf("A note should be clean after a full sync, got dirty")
	}
	var propsA map[string]any
	if err := json.Unmarshal(gotA.Props, &propsA); err != nil || propsA["status"] != "done" {
		t.Errorf("A lost props after sync: %s (err %v)", string(gotA.Props), err)
	}

	// The other device receives the archetype on its note.
	gotB, err := b.store.Notes.Get(note.ID)
	if err != nil || gotB.ObjectTypeID == nil || *gotB.ObjectTypeID != ot.ID {
		t.Fatalf("B did not receive the archetype: %+v (err %v)", gotB, err)
	}
}

// syncAll runs a full sync cycle on each client until they converge (push may seed
// conflicts whose canonical rows arrive on the next pull).
func syncAll(t *testing.T, clients ...*client) {
	t.Helper()
	for range 2 {
		for _, c := range clients {
			if err := c.engine.Sync(); err != nil {
				t.Fatalf("sync: %v", err)
			}
		}
	}
}

func hasPropEdge(t *testing.T, c *client, sourceID, targetID, kind string) bool {
	t.Helper()
	g, err := c.store.Links.Full()
	if err != nil {
		t.Fatalf("graph full: %v", err)
	}
	for _, e := range g.Edges {
		if e.Kind == kind && e.SourceID == sourceID && e.TargetID == targetID {
			return true
		}
	}
	return false
}
