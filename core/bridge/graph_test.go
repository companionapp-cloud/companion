package bridge

import (
	"encoding/json"
	"testing"

	"companion/core/domain"
)

func TestGraphOverBridge(t *testing.T) {
	c, h := newTestCore(t)

	out, _ := c.Invoke("notes.create", []byte(`{"title":"Target","contentMd":""}`))
	var target domain.Note
	json.Unmarshal(out, &target)

	_, err := c.Invoke("notes.create",
		[]byte(`{"title":"Source","contentMd":"points at [[note:`+target.ID+`]]"}`))
	if err != nil {
		t.Fatalf("create source: %v", err)
	}

	// graph.full exposes the derived edge.
	out, err = c.Invoke("graph.full", nil)
	if err != nil {
		t.Fatalf("graph.full: %v", err)
	}
	var g domain.Graph
	if err := json.Unmarshal(out, &g); err != nil {
		t.Fatalf("decode graph: %v", err)
	}
	if len(g.Nodes) != 2 {
		t.Errorf("nodes = %d, want 2: %+v", len(g.Nodes), g.Nodes)
	}
	if len(g.Edges) != 1 || g.Edges[0].TargetID != target.ID || g.Edges[0].Kind != domain.KindRef {
		t.Fatalf("unexpected edges: %+v", g.Edges)
	}

	// graph.backlinks resolves the source.
	out, err = c.Invoke("graph.backlinks", []byte(`{"type":"note","id":"`+target.ID+`"}`))
	if err != nil {
		t.Fatalf("graph.backlinks: %v", err)
	}
	var back []domain.GraphNode
	json.Unmarshal(out, &back)
	if len(back) != 1 {
		t.Errorf("backlinks = %d, want 1: %+v", len(back), back)
	}

	// graph.rebuild reports counts and signals a bulk change.
	out, err = c.Invoke("graph.rebuild", nil)
	if err != nil {
		t.Fatalf("graph.rebuild: %v", err)
	}
	var counts map[string]int
	json.Unmarshal(out, &counts)
	if counts["edges"] != 1 || counts["nodes"] != 2 {
		t.Errorf("rebuild counts = %+v, want {nodes:2, edges:1}", counts)
	}
	if h.count("data.changed") == 0 {
		t.Error("expected data.changed to fire")
	}
}
