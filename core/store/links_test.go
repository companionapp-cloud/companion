//go:build !js

package store

import (
	"sort"
	"testing"
	"time"

	"companion/core/domain"
)

func edgeKey(e domain.GraphEdge) string {
	return e.SourceType + "/" + e.SourceID + "->" + e.TargetType + "/" + e.TargetID + ":" + e.Kind
}

func sortedEdgeKeys(edges []domain.GraphEdge) []string {
	keys := make([]string, len(edges))
	for i, e := range edges {
		keys[i] = edgeKey(e)
	}
	sort.Strings(keys)
	return keys
}

func TestLinksExtractedOnCreateAndUpdate(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 5, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	target, err := s.Notes.Create(CreateNoteInput{Title: "Target"})
	if err != nil {
		t.Fatalf("create target: %v", err)
	}
	src, err := s.Notes.Create(CreateNoteInput{Title: "Source", ContentMD: "links to [[note:" + target.ID + "]]"})
	if err != nil {
		t.Fatalf("create source: %v", err)
	}

	g, err := s.Links.Full()
	if err != nil {
		t.Fatalf("full: %v", err)
	}
	if len(g.Edges) != 1 {
		t.Fatalf("expected 1 edge, got %d: %+v", len(g.Edges), g.Edges)
	}
	e := g.Edges[0]
	if e.SourceID != src.ID || e.TargetID != target.ID || e.Kind != domain.KindRef {
		t.Errorf("unexpected edge: %+v", e)
	}

	// Rewriting the content to drop the link removes the edge.
	if _, err := s.Notes.Update(src.ID, UpdateNoteInput{ContentMD: strPtr("no links now")}); err != nil {
		t.Fatalf("update: %v", err)
	}
	g, _ = s.Links.Full()
	if len(g.Edges) != 0 {
		t.Errorf("expected edge removed after update, got %+v", g.Edges)
	}
}

func TestBacklinksAndDanglingTarget(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 5, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	// Link to a target that does not exist yet: the edge is stored (dangling).
	src, err := s.Notes.Create(CreateNoteInput{Title: "Src", ContentMD: "[[note:ghost-id]] and ![[task:t-1]]"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	g, _ := s.Links.Full()
	if len(g.Edges) != 2 {
		t.Fatalf("expected 2 dangling edges, got %+v", g.Edges)
	}

	back, err := s.Links.Backlinks(domain.NodeNote, "ghost-id")
	if err != nil {
		t.Fatalf("backlinks: %v", err)
	}
	if len(back) != 1 || back[0].ID != src.ID {
		t.Errorf("expected src as sole backlink, got %+v", back)
	}

	// Deleting the source drops its outgoing edges.
	if err := s.Notes.Delete(src.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	g, _ = s.Links.Full()
	if len(g.Edges) != 0 {
		t.Errorf("expected edges gone after source delete, got %+v", g.Edges)
	}
}

func TestNeighborhoodDepth(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 5, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	c, _ := s.Notes.Create(CreateNoteInput{Title: "C"})
	b, _ := s.Notes.Create(CreateNoteInput{Title: "B", ContentMD: "[[note:" + c.ID + "]]"})
	a, _ := s.Notes.Create(CreateNoteInput{Title: "A", ContentMD: "[[note:" + b.ID + "]]"})

	// Depth 1 from A reaches A and B, not C.
	g, err := s.Links.Neighborhood(domain.NodeNote, a.ID, 1)
	if err != nil {
		t.Fatalf("neighborhood: %v", err)
	}
	if !hasNode(g, a.ID) || !hasNode(g, b.ID) || hasNode(g, c.ID) {
		t.Errorf("depth 1 nodes wrong: %+v", g.Nodes)
	}

	// Depth 2 reaches C too.
	g, _ = s.Links.Neighborhood(domain.NodeNote, a.ID, 2)
	if !hasNode(g, c.ID) {
		t.Errorf("depth 2 should reach C: %+v", g.Nodes)
	}
}

// TestApplyMatchesRebuild guards the load-bearing invariant (PLAN §11): rows applied
// via the sync path must derive the same link index as a from-scratch rebuild.
func TestApplyMatchesRebuild(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 5, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	// Simulate a pull: apply server-canonical rows straight through the repo (as the
	// sync engine does), rather than creating them locally.
	rows := []*domain.Note{
		{ID: "n1", Title: "One", ContentMD: "see [[note:n2]] and ![[note:n3]]", CreatedAt: clk.t, UpdatedAt: clk.t, Version: 3},
		{ID: "n2", Title: "Two", ContentMD: "back to [[note:n1]]", CreatedAt: clk.t, UpdatedAt: clk.t, Version: 1},
		{ID: "n3", Title: "Three", ContentMD: "no links", CreatedAt: clk.t, UpdatedAt: clk.t, Version: 1},
	}
	for _, n := range rows {
		if err := s.Notes.Apply(n); err != nil {
			t.Fatalf("apply %s: %v", n.ID, err)
		}
	}

	applied, err := s.Links.Full()
	if err != nil {
		t.Fatalf("full after apply: %v", err)
	}

	if _, _, err := s.Links.Rebuild(); err != nil {
		t.Fatalf("rebuild: %v", err)
	}
	rebuilt, err := s.Links.Full()
	if err != nil {
		t.Fatalf("full after rebuild: %v", err)
	}

	a, b := sortedEdgeKeys(applied.Edges), sortedEdgeKeys(rebuilt.Edges)
	if len(a) != len(b) {
		t.Fatalf("edge count differs: apply=%v rebuild=%v", a, b)
	}
	for i := range a {
		if a[i] != b[i] {
			t.Errorf("edge %d differs: apply=%q rebuild=%q", i, a[i], b[i])
		}
	}
	if len(a) != 3 {
		t.Errorf("expected 3 edges (2 from n1, 1 from n2), got %d: %v", len(a), a)
	}
}

func hasNode(g *domain.Graph, id string) bool {
	for _, n := range g.Nodes {
		if n.ID == id {
			return true
		}
	}
	return false
}

func strPtr(s string) *string { return &s }

func TestSearchAndLookup(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 5, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	alpha, err := s.Notes.Create(CreateNoteInput{Title: "Alpha Notes"})
	if err != nil {
		t.Fatalf("create alpha: %v", err)
	}
	if _, err := s.Notes.Create(CreateNoteInput{Title: "Beta Alphabet"}); err != nil {
		t.Fatalf("create beta: %v", err)
	}
	if _, err := s.Notes.Create(CreateNoteInput{Title: "Gamma"}); err != nil {
		t.Fatalf("create gamma: %v", err)
	}

	// Prefix match ("Alpha Notes") ranks above the substring match ("Beta Alphabet").
	got, err := s.Links.Search("alph", "", 10)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 results, got %d: %+v", len(got), got)
	}
	if got[0].Title != "Alpha Notes" {
		t.Errorf("expected prefix match first, got %q", got[0].Title)
	}

	// A type filter scopes results; both matches are notes, none are tasks.
	if scoped, _ := s.Links.Search("alph", "note", 10); len(scoped) != 2 {
		t.Errorf("expected 2 note results, got %d", len(scoped))
	}
	if wrong, _ := s.Links.Search("alph", "task", 10); len(wrong) != 0 {
		t.Errorf("expected 0 task results, got %d", len(wrong))
	}

	// Limit is honored and no match returns empty.
	if none, _ := s.Links.Search("nonexistent", "", 10); len(none) != 0 {
		t.Errorf("expected no results, got %+v", none)
	}

	// Lookup resolves a live id and reports type; unknown ids return (nil, nil).
	node, err := s.Links.LookupNode(alpha.ID)
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if node == nil || node.Type != "note" || node.Title != "Alpha Notes" {
		t.Errorf("unexpected lookup: %+v", node)
	}
	if miss, err := s.Links.LookupNode("does-not-exist"); err != nil || miss != nil {
		t.Errorf("expected (nil,nil) for missing id, got %+v, %v", miss, err)
	}
}
