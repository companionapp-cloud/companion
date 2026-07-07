//go:build !js

package store

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"companion/core/domain"
)

func newBookType(t *testing.T, s *Store) *domain.ObjectType {
	t.Helper()
	schema := mustSchema(domain.ObjectSchema{Fields: []domain.ObjectField{
		{Key: "author", Type: domain.FieldReference, To: domain.NodeNote},
		{Key: "status", Type: domain.FieldSelect, Options: []string{"to-read", "done"}, Required: true},
	}})
	ot, err := s.ObjectTypes.Create(CreateObjectTypeInput{Name: "Book", AppliesTo: domain.AppliesToNote, SchemaJSON: schema})
	if err != nil {
		t.Fatalf("create object type: %v", err)
	}
	return ot
}

func TestObjectTypeCRUDAndSync(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	ot := newBookType(t, s)
	if ot.AppliesTo != domain.AppliesToNote || ot.SchemaVersion != 1 {
		t.Fatalf("defaults not applied: %+v", ot)
	}

	got, err := s.ObjectTypes.Get(ot.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Name != "Book" {
		t.Errorf("round-trip name = %q", got.Name)
	}

	// SchemaFor resolves the parsed schema for the link extractor.
	schema, ok, err := s.ObjectTypes.SchemaFor(ot.ID)
	if err != nil || !ok {
		t.Fatalf("SchemaFor: ok=%v err=%v", ok, err)
	}
	if len(schema.Fields) != 2 {
		t.Errorf("schema fields = %d, want 2", len(schema.Fields))
	}

	// A missing type resolves to ok=false (dangling, tolerated).
	if _, ok, _ := s.ObjectTypes.SchemaFor("nope"); ok {
		t.Error("missing type should resolve ok=false")
	}
}

func TestNoteWithArchetypeValidatesAndExtractsPropEdges(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)
	ot := newBookType(t, s)

	// Missing required "status" is rejected by the shared validator.
	if _, err := s.Notes.Create(CreateNoteInput{
		Title: "Dune", ObjectTypeID: &ot.ID, Props: mustJSON(map[string]any{"author": "note-1"}),
	}); !errors.Is(err, domain.ErrInvalidProps) {
		t.Fatalf("expected ErrInvalidProps, got %v", err)
	}

	// Valid archetyped note stores props and derives a prop:author edge.
	n, err := s.Notes.Create(CreateNoteInput{
		Title: "Dune", ObjectTypeID: &ot.ID,
		Props: mustJSON(map[string]any{"author": "note-herbert", "status": "done"}),
	})
	if err != nil {
		t.Fatalf("create archetyped note: %v", err)
	}

	edges := backlinkKinds(t, s, domain.NodeNote, "note-herbert")
	if edges["prop:author"] != 1 {
		t.Errorf("expected a prop:author edge to note-herbert, got %v", edges)
	}

	// Rebuild reproduces the identical index (the load-bearing invariant, PLAN §5.1).
	before := allLinks(t, s)
	if _, _, err := s.Links.Rebuild(); err != nil {
		t.Fatalf("rebuild: %v", err)
	}
	after := allLinks(t, s)
	if before != after {
		t.Errorf("rebuild changed the index:\n before=%v\n after=%v", before, after)
	}

	// Clearing the archetype drops the prop edge.
	if _, err := s.Notes.Update(n.ID, UpdateNoteInput{ClearObjectType: true, Props: rawPtr(`{}`)}); err != nil {
		t.Fatalf("clear archetype: %v", err)
	}
	if edges := backlinkKinds(t, s, domain.NodeNote, "note-herbert"); edges["prop:author"] != 0 {
		t.Errorf("prop edge should be gone after clearing archetype, got %v", edges)
	}
}

// backlinkKinds returns a count of edge kinds pointing at (typ,id).
func backlinkKinds(t *testing.T, s *Store, typ, id string) map[string]int {
	t.Helper()
	g, err := s.Links.Full()
	if err != nil {
		t.Fatalf("graph.full: %v", err)
	}
	out := map[string]int{}
	for _, e := range g.Edges {
		if e.TargetType == typ && e.TargetID == id {
			out[e.Kind]++
		}
	}
	return out
}

// allLinks returns a stable string of every edge, for comparing extraction vs rebuild.
func allLinks(t *testing.T, s *Store) string {
	t.Helper()
	g, err := s.Links.Full()
	if err != nil {
		t.Fatalf("graph.full: %v", err)
	}
	keys := make([]string, 0, len(g.Edges))
	for _, e := range g.Edges {
		keys = append(keys, e.SourceType+"/"+e.SourceID+"->"+e.TargetType+"/"+e.TargetID+"#"+e.Kind)
	}
	return sortedJoin(keys)
}

func sortedJoin(keys []string) string {
	// simple insertion sort to avoid importing sort in the test's hot path
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j-1] > keys[j]; j-- {
			keys[j-1], keys[j] = keys[j], keys[j-1]
		}
	}
	out := ""
	for _, k := range keys {
		out += k + "\n"
	}
	return out
}

func mustSchema(s domain.ObjectSchema) json.RawMessage { return mustJSON(s) }

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func rawPtr(s string) *json.RawMessage {
	r := json.RawMessage(s)
	return &r
}
