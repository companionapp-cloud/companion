//go:build !js

package store

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"companion/core/domain"
)

func strp(s string) *string { return &s }

func TestCanvasesCRUDAndTrash(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 12, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	cv, err := s.Canvases.Create(CreateCanvasInput{Name: "  Q3 launch "})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if cv.Name != "Q3 launch" || !cv.Dirty || cv.Version != 0 {
		t.Fatalf("unexpected canvas: %+v", cv)
	}
	got, err := s.Canvases.Get(cv.ID)
	if err != nil || got.Name != "Q3 launch" {
		t.Fatalf("get = %+v (err %v)", got, err)
	}
	if _, err := s.Canvases.Update(cv.ID, UpdateCanvasInput{Name: strp("Launch")}); err != nil {
		t.Fatalf("update: %v", err)
	}
	list, err := s.Canvases.List()
	if err != nil || len(list) != 1 || list[0].Name != "Launch" {
		t.Fatalf("list = %+v (err %v)", list, err)
	}

	// Trash hides it from Get/List, shows it in ListTrash, and Restore brings it back.
	if err := s.Canvases.Trash(cv.ID); err != nil {
		t.Fatalf("trash: %v", err)
	}
	if _, err := s.Canvases.Get(cv.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("trashed canvas still gettable: %v", err)
	}
	if tr, _ := s.Canvases.ListTrash(); len(tr) != 1 || tr[0].DeletingAt == nil {
		t.Fatalf("trash list = %+v", tr)
	}
	if err := s.Canvases.Restore(cv.ID); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if _, err := s.Canvases.Get(cv.ID); err != nil {
		t.Fatalf("restored canvas missing: %v", err)
	}
	if err := s.Canvases.Delete(cv.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	any, _ := s.Canvases.GetAny(cv.ID)
	if any.DeletedAt == nil || !any.Dirty {
		t.Fatalf("tombstone not recorded: %+v", any)
	}
}

func TestCanvasNodesEdgesAndRefMirroring(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 12, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	cv, err := s.Canvases.Create(CreateCanvasInput{Name: "Board"})
	if err != nil {
		t.Fatalf("create canvas: %v", err)
	}
	note, err := s.Notes.Create(CreateNoteInput{Title: "Spec"})
	if err != nil {
		t.Fatalf("create note: %v", err)
	}

	nodes, err := s.CanvasNodes.UpsertMany(cv.ID, []CanvasNodeInput{
		{Kind: domain.CanvasNodeText, X: 10, Y: 20, Width: 200, Height: 120, Data: json.RawMessage(`{"text":"hello"}`)},
		{Kind: domain.CanvasNodeNote, X: 300, Y: 20, Width: 240, Height: 160, RefType: strp(domain.NodeNote), RefID: strp(note.ID)},
		{Kind: domain.CanvasNodeGroup, X: 0, Y: 0, Width: 800, Height: 600, Z: -1, Data: json.RawMessage(`{"label":"Phase 1"}`)},
	})
	if err != nil {
		t.Fatalf("upsert nodes: %v", err)
	}
	if len(nodes) != 3 || nodes[0].ID == "" || !nodes[0].Dirty {
		t.Fatalf("unexpected nodes: %+v", nodes)
	}
	// Geometry round-trips as floats.
	listed, err := s.CanvasNodes.ListForCanvas(cv.ID)
	if err != nil {
		t.Fatalf("list nodes: %v", err)
	}
	if len(listed) != 3 || listed[0].Kind != domain.CanvasNodeGroup /* z=-1 first */ {
		t.Fatalf("unexpected order: %+v", listed)
	}
	if listed[1].X != 10 || listed[1].Y != 20 || listed[1].Width != 200 || string(listed[1].Data) != `{"text":"hello"}` {
		t.Fatalf("sticky round-trip mismatch: %+v", listed[1])
	}

	// The note reference mirrored into the link index as a 'canvas' edge.
	if !hasCanvasEdge(t, s, cv.ID, note.ID) {
		t.Fatalf("expected canvas → note edge")
	}

	// Moving the sticky keeps its id/created_at and re-flags it dirty.
	moved, err := s.CanvasNodes.UpsertMany(cv.ID, []CanvasNodeInput{{ID: nodes[0].ID, Kind: domain.CanvasNodeText, X: 50, Y: 60, Width: 200, Height: 120, Data: nodes[0].Data}})
	if err != nil {
		t.Fatalf("move: %v", err)
	}
	if moved[0].ID != nodes[0].ID || moved[0].X != 50 || !moved[0].CreatedAt.Equal(nodes[0].CreatedAt) {
		t.Fatalf("move mismatch: %+v", moved[0])
	}

	// Validation: a note node without a ref, and a sticky with a ref, are rejected.
	if _, err := s.CanvasNodes.UpsertMany(cv.ID, []CanvasNodeInput{{Kind: domain.CanvasNodeNote, Width: 10, Height: 10}}); !errors.Is(err, domain.ErrInvalidCanvas) {
		t.Fatalf("expected invalid note node, got %v", err)
	}
	if _, err := s.CanvasNodes.UpsertMany(cv.ID, []CanvasNodeInput{{Kind: domain.CanvasNodeText, Width: 10, Height: 10, RefType: strp("note"), RefID: strp("x")}}); !errors.Is(err, domain.ErrInvalidCanvas) {
		t.Fatalf("expected invalid sticky ref, got %v", err)
	}

	// Edges between the sticky and the note node.
	edges, err := s.CanvasEdges.UpsertMany(cv.ID, []CanvasEdgeInput{{FromNodeID: nodes[0].ID, ToNodeID: nodes[1].ID, Label: "depends on"}})
	if err != nil {
		t.Fatalf("upsert edge: %v", err)
	}
	if edges[0].FromEnd != domain.CanvasEndNone || edges[0].ToEnd != domain.CanvasEndArrow {
		t.Fatalf("edge end defaults: %+v", edges[0])
	}
	if _, err := s.CanvasEdges.UpsertMany(cv.ID, []CanvasEdgeInput{{FromNodeID: nodes[0].ID, ToNodeID: nodes[0].ID}}); !errors.Is(err, domain.ErrInvalidCanvas) {
		t.Fatalf("self-edge should be rejected, got %v", err)
	}

	// Deleting the note node cascades its edges and drops the mirrored graph edge.
	gone, err := s.CanvasEdges.DeleteForNodes([]string{nodes[1].ID})
	if err != nil || len(gone) != 1 {
		t.Fatalf("DeleteForNodes = %v (err %v)", gone, err)
	}
	if n, err := s.CanvasNodes.DeleteMany([]string{nodes[1].ID}); err != nil || n != 1 {
		t.Fatalf("DeleteMany = %d (err %v)", n, err)
	}
	if hasCanvasEdge(t, s, cv.ID, note.ID) {
		t.Fatalf("canvas → note edge should be gone after node delete")
	}
	if live, _ := s.CanvasEdges.ListForCanvas(cv.ID); len(live) != 0 {
		t.Fatalf("edges should be tombstoned, got %d", len(live))
	}
	if live, _ := s.CanvasNodes.ListForCanvas(cv.ID); len(live) != 2 {
		t.Fatalf("expected 2 live nodes, got %d", len(live))
	}

	// Trashing the board removes its graph edges; Rebuild + Restore bring them back.
	if _, err := s.CanvasNodes.UpsertMany(cv.ID, []CanvasNodeInput{{Kind: domain.CanvasNodeNote, X: 1, Y: 1, Width: 10, Height: 10, RefType: strp(domain.NodeNote), RefID: strp(note.ID)}}); err != nil {
		t.Fatalf("re-add note node: %v", err)
	}
	if err := s.Canvases.Trash(cv.ID); err != nil {
		t.Fatalf("trash: %v", err)
	}
	if hasCanvasEdge(t, s, cv.ID, note.ID) {
		t.Fatalf("trashed board should have no outgoing edges")
	}
	if err := s.Canvases.Restore(cv.ID); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if !hasCanvasEdge(t, s, cv.ID, note.ID) {
		t.Fatalf("restored board should re-mirror its edges")
	}
	if _, _, err := s.Links.Rebuild(); err != nil {
		t.Fatalf("rebuild: %v", err)
	}
	if !hasCanvasEdge(t, s, cv.ID, note.ID) {
		t.Fatalf("rebuild should re-derive canvas edges")
	}

	// Viewport persistence is local-only and float-precise.
	if v, _ := s.Canvases.GetView(cv.ID); v != nil {
		t.Fatalf("expected no view yet, got %+v", v)
	}
	if err := s.Canvases.SetView(cv.ID, CanvasView{X: -12.5, Y: 40.25, Zoom: 0.75}); err != nil {
		t.Fatalf("set view: %v", err)
	}
	if v, err := s.Canvases.GetView(cv.ID); err != nil || v == nil || v.X != -12.5 || v.Zoom != 0.75 {
		t.Fatalf("get view = %+v (err %v)", v, err)
	}
}

func hasCanvasEdge(t *testing.T, s *Store, canvasID, noteID string) bool {
	t.Helper()
	g, err := s.Links.Full()
	if err != nil {
		t.Fatalf("graph full: %v", err)
	}
	for _, e := range g.Edges {
		if e.Kind == domain.KindCanvas && e.SourceType == domain.NodeCanvas && e.SourceID == canvasID && e.TargetID == noteID {
			return true
		}
	}
	return false
}
