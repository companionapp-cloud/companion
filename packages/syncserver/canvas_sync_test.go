package syncserver

import (
	"encoding/json"
	"testing"
	"time"

	"companion/core/domain"
	"companion/core/store"
)

func strp(s string) *string { return &s }

// A board built on device A converges on device B with its nodes, edges, and the mirrored
// 'canvas' graph edge; concurrent moves of *different* nodes merge; concurrent moves of the
// *same* node resolve last-writer-wins with no forked row (PLAN-canvases.md §0).
func TestCanvasSyncConvergesAndMergesPerNode(t *testing.T) {
	ts := newServer(t)
	token := register(t, ts.URL, "c@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	cv, err := a.store.Canvases.Create(store.CreateCanvasInput{Name: "Roadmap"})
	if err != nil {
		t.Fatalf("create canvas: %v", err)
	}
	note, err := a.store.Notes.Create(store.CreateNoteInput{Title: "Spec"})
	if err != nil {
		t.Fatalf("create note: %v", err)
	}
	nodes, err := a.store.CanvasNodes.UpsertMany(cv.ID, []store.CanvasNodeInput{
		{Kind: domain.CanvasNodeText, X: 0, Y: 0, Width: 200, Height: 100, Data: json.RawMessage(`{"text":"hi"}`)},
		{Kind: domain.CanvasNodeNote, X: 300, Y: 0, Width: 240, Height: 160, RefType: strp(domain.NodeNote), RefID: strp(note.ID)},
	})
	if err != nil {
		t.Fatalf("upsert nodes: %v", err)
	}
	if _, err := a.store.CanvasEdges.UpsertMany(cv.ID, []store.CanvasEdgeInput{{FromNodeID: nodes[0].ID, ToNodeID: nodes[1].ID, Label: "see"}}); err != nil {
		t.Fatalf("upsert edge: %v", err)
	}
	if err := a.engine.Sync(); err != nil {
		t.Fatalf("A sync: %v", err)
	}
	if err := b.engine.Sync(); err != nil {
		t.Fatalf("B sync: %v", err)
	}

	gotCv, err := b.store.Canvases.Get(cv.ID)
	if err != nil || gotCv.Name != "Roadmap" || gotCv.Dirty || gotCv.Version == 0 {
		t.Fatalf("B canvas = %+v (err %v)", gotCv, err)
	}
	bNodes, err := b.store.CanvasNodes.ListForCanvas(cv.ID)
	if err != nil || len(bNodes) != 2 {
		t.Fatalf("B nodes = %+v (err %v)", bNodes, err)
	}
	for _, n := range bNodes {
		if n.Dirty || n.Version == 0 {
			t.Errorf("synced node should be clean with a version: %+v", n)
		}
	}
	bEdges, err := b.store.CanvasEdges.ListForCanvas(cv.ID)
	if err != nil || len(bEdges) != 1 || bEdges[0].Label != "see" || bEdges[0].ToEnd != domain.CanvasEndArrow {
		t.Fatalf("B edges = %+v (err %v)", bEdges, err)
	}
	if !hasCanvasGraphEdge(t, b, cv.ID, note.ID) {
		t.Errorf("B did not mirror the canvas → note edge")
	}

	// Different nodes moved on each device merge: both moves survive everywhere.
	a.clk.t = base.Add(time.Hour)
	b.clk.t = base.Add(time.Hour)
	if _, err := a.store.CanvasNodes.UpsertMany(cv.ID, []store.CanvasNodeInput{{ID: nodes[0].ID, Kind: domain.CanvasNodeText, X: 111, Y: 0, Width: 200, Height: 100, Data: json.RawMessage(`{"text":"hi"}`)}}); err != nil {
		t.Fatalf("A move: %v", err)
	}
	if _, err := b.store.CanvasNodes.UpsertMany(cv.ID, []store.CanvasNodeInput{{ID: nodes[1].ID, Kind: domain.CanvasNodeNote, X: 999, Y: 0, Width: 240, Height: 160, RefType: strp(domain.NodeNote), RefID: strp(note.ID)}}); err != nil {
		t.Fatalf("B move: %v", err)
	}
	for _, c := range []*client{a, b, a} {
		if err := c.engine.Sync(); err != nil {
			t.Fatalf("sync: %v", err)
		}
	}
	for _, c := range []*client{a, b} {
		ns, _ := c.store.CanvasNodes.ListForCanvas(cv.ID)
		byID := map[string]*domain.CanvasNode{}
		for _, n := range ns {
			byID[n.ID] = n
		}
		if len(ns) != 2 || byID[nodes[0].ID].X != 111 || byID[nodes[1].ID].X != 999 {
			t.Fatalf("per-node merge failed: %+v", ns)
		}
	}

	// The same node moved on both: the newer write wins, and no extra node appears.
	a.clk.t = base.Add(2 * time.Hour)
	b.clk.t = base.Add(3 * time.Hour)
	if _, err := a.store.CanvasNodes.UpsertMany(cv.ID, []store.CanvasNodeInput{{ID: nodes[0].ID, Kind: domain.CanvasNodeText, X: 1, Y: 0, Width: 200, Height: 100}}); err != nil {
		t.Fatalf("A move 2: %v", err)
	}
	if _, err := b.store.CanvasNodes.UpsertMany(cv.ID, []store.CanvasNodeInput{{ID: nodes[0].ID, Kind: domain.CanvasNodeText, X: 2, Y: 0, Width: 200, Height: 100}}); err != nil {
		t.Fatalf("B move 2: %v", err)
	}
	for _, c := range []*client{a, b, a} {
		if err := c.engine.Sync(); err != nil {
			t.Fatalf("sync: %v", err)
		}
	}
	for _, c := range []*client{a, b} {
		ns, _ := c.store.CanvasNodes.ListForCanvas(cv.ID)
		if len(ns) != 2 {
			t.Fatalf("same-node conflict forked a copy: %d nodes", len(ns))
		}
		for _, n := range ns {
			if n.ID == nodes[0].ID && n.X != 2 {
				t.Fatalf("newer write should win, got x=%v", n.X)
			}
		}
	}
}

// Trashing a board syncs the trash state; when the server's collector purges it, the
// board's nodes and edges tombstone too and every device drops them.
func TestCanvasTrashPurgeCascades(t *testing.T) {
	ts, srv := newServerAPI(t)
	token := register(t, ts.URL, "p@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	cv, err := a.store.Canvases.Create(store.CreateCanvasInput{Name: "Old"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	nodes, err := a.store.CanvasNodes.UpsertMany(cv.ID, []store.CanvasNodeInput{
		{Kind: domain.CanvasNodeText, Width: 10, Height: 10},
		{Kind: domain.CanvasNodeText, Width: 10, Height: 10},
	})
	if err != nil {
		t.Fatalf("nodes: %v", err)
	}
	if _, err := a.store.CanvasEdges.UpsertMany(cv.ID, []store.CanvasEdgeInput{{FromNodeID: nodes[0].ID, ToNodeID: nodes[1].ID}}); err != nil {
		t.Fatalf("edge: %v", err)
	}
	if err := a.store.Canvases.Trash(cv.ID); err != nil {
		t.Fatalf("trash: %v", err)
	}
	for _, c := range []*client{a, b} {
		if err := c.engine.Sync(); err != nil {
			t.Fatalf("sync: %v", err)
		}
	}
	if tr, _ := b.store.Canvases.ListTrash(); len(tr) != 1 {
		t.Fatalf("B should see the trashed board, got %d", len(tr))
	}

	// Retention elapses; the collector tombstones the board and its children.
	srv.clock = &testClock{t: base.Add(store.TrashRetention + time.Hour)}
	if n, err := srv.PurgeExpired(); err != nil || n != 1 {
		t.Fatalf("purge = %d (err %v)", n, err)
	}
	for _, c := range []*client{a, b} {
		if err := c.engine.Sync(); err != nil {
			t.Fatalf("sync: %v", err)
		}
		if any, _ := c.store.Canvases.GetAny(cv.ID); any.DeletedAt == nil {
			t.Fatalf("board should be tombstoned")
		}
		if ns, _ := c.store.CanvasNodes.ListForCanvas(cv.ID); len(ns) != 0 {
			t.Fatalf("nodes should be tombstoned, got %d", len(ns))
		}
		if es, _ := c.store.CanvasEdges.ListForCanvas(cv.ID); len(es) != 0 {
			t.Fatalf("edges should be tombstoned, got %d", len(es))
		}
	}
}

func hasCanvasGraphEdge(t *testing.T, c *client, canvasID, targetID string) bool {
	t.Helper()
	g, err := c.store.Links.Full()
	if err != nil {
		t.Fatalf("graph full: %v", err)
	}
	for _, e := range g.Edges {
		if e.Kind == domain.KindCanvas && e.SourceID == canvasID && e.TargetID == targetID {
			return true
		}
	}
	return false
}
