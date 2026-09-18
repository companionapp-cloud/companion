//go:build !js

package llm

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"companion/core/domain"
	"companion/core/store"
)

type canvasResult struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Wikilink  string          `json:"wikilink"`
	Nodes     []canvasNodeOut `json:"nodes"`
	Edges     []canvasEdgeOut `json:"edges"`
	Truncated bool            `json:"truncated"`
}

func node(kind string, x, y, w, h float64, data string) store.CanvasNodeInput {
	in := store.CanvasNodeInput{Kind: kind, X: x, Y: y, Width: w, Height: h}
	if data != "" {
		in.Data = json.RawMessage(data)
	}
	return in
}

func refNode(kind, refType, refID string, x, y float64, data string) store.CanvasNodeInput {
	in := node(kind, x, y, 260, 120, data)
	in.RefType, in.RefID = &refType, &refID
	return in
}

// TestGetCanvasReadsTheBoard checks get_canvas gives the model the board as a person reads it:
// cards in reading order with what they say, the innermost group each sits in, embedded entities
// resolved (or marked gone), and which way each arrow points.
func TestGetCanvasReadsTheBoard(t *testing.T) {
	s := newTestStore(t)
	r := NewStoreRegistry(s)
	note, err := s.Notes.Create(store.CreateNoteInput{Title: "Beta scope", ContentMD: "# Scope\n\nOnly the   sync engine."})
	if err != nil {
		t.Fatal(err)
	}
	task, err := s.Tasks.Create(store.CreateTaskInput{Title: "Cut the release"})
	if err != nil {
		t.Fatal(err)
	}
	done := domain.TaskDone
	if _, err := s.Tasks.Update(task.ID, store.UpdateTaskInput{Status: &done}); err != nil {
		t.Fatal(err)
	}
	cv, err := s.Canvases.Create(store.CreateCanvasInput{Name: "Q3 plan"})
	if err != nil {
		t.Fatal(err)
	}
	nodes, err := s.CanvasNodes.UpsertMany(cv.ID, []store.CanvasNodeInput{
		node(domain.CanvasNodeGroup, 0, 0, 900, 500, `{"label":"Launch"}`),
		node(domain.CanvasNodeGroup, 20, 40, 560, 300, `{"label":"Beta"}`),
		node(domain.CanvasNodeText, 40, 90, 200, 120, `{"text":"Ship the beta"}`),
		refNode(domain.CanvasNodeNote, domain.NodeNote, note.ID, 300, 85, ""),
		refNode(domain.CanvasNodeTask, domain.NodeTask, task.ID, 1000, 95, ""),
		refNode(domain.CanvasNodeEvent, "event", "gone-event", 620, 380, `{"title":"Kickoff","startsAt":"2026-09-01T13:00:00Z"}`),
		node(domain.CanvasNodeLink, 40, 600, 300, 220, `{"url":"https://example.com/spec","title":"Spec","siteName":"Example"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	launch, beta, sticky, noteCard, taskCard := nodes[0], nodes[1], nodes[2], nodes[3], nodes[4]
	if _, err := s.CanvasEdges.UpsertMany(cv.ID, []store.CanvasEdgeInput{
		{FromNodeID: sticky.ID, ToNodeID: noteCard.ID, FromEnd: domain.CanvasEndNone, ToEnd: domain.CanvasEndArrowFilled, Style: domain.CanvasStyleCurved, Label: "details"},
		{FromNodeID: taskCard.ID, ToNodeID: noteCard.ID, FromEnd: domain.CanvasEndArrow, ToEnd: domain.CanvasEndArrow, Style: domain.CanvasStyleStraight},
	}); err != nil {
		t.Fatal(err)
	}

	got := invokeJSON[canvasResult](t, r, "get_canvas", `{"id":"`+cv.ID+`"}`)
	if got.Name != "Q3 plan" || got.Wikilink != "[[canvas:"+cv.ID+"]]" || got.Truncated {
		t.Errorf("board = %+v", got)
	}
	var order []string
	byID := map[string]canvasNodeOut{}
	for _, n := range got.Nodes {
		order = append(order, n.Kind)
		byID[n.ID] = n
	}
	// Rows of 80 units: the groups and the sticky/note/task band first (left to right), then
	// the event, then the link far below.
	if want := "group|group|text|note|task|event|link"; strings.Join(order, "|") != want {
		t.Errorf("reading order = %v, want %s", order, want)
	}
	if n := byID[sticky.ID]; n.Text != "Ship the beta" || n.Group != beta.ID {
		t.Errorf("sticky = %+v, want it inside the inner group %s", n, beta.ID)
	}
	if n := byID[beta.ID]; n.Text != "Beta" || n.Group != launch.ID {
		t.Errorf("inner group = %+v", n)
	}
	if n := byID[noteCard.ID]; n.Title != "Beta scope" || n.Excerpt != "# Scope Only the sync engine." || n.Wikilink != "[[note:"+note.ID+"]]" || n.Group != beta.ID {
		t.Errorf("note card = %+v", n)
	}
	if n := byID[taskCard.ID]; n.Title != "Cut the release" || n.Status != "done" || n.Group != "" {
		t.Errorf("task card = %+v (it sits outside every group)", n)
	}
	for _, n := range got.Nodes {
		if n.Kind == "event" && (!n.Missing || n.Title != "Kickoff" || n.Group != launch.ID) {
			t.Errorf("event card = %+v, want the cached title of a missing event", n)
		}
		if n.Kind == "link" && (n.URL != "https://example.com/spec" || n.Title != "Spec" || n.Site != "Example") {
			t.Errorf("link card = %+v", n)
		}
	}
	if len(got.Edges) != 2 {
		t.Fatalf("edges = %+v", got.Edges)
	}
	for _, e := range got.Edges {
		switch e.From {
		case sticky.ID:
			if e.Arrow != "forward" || e.Label != "details" {
				t.Errorf("sticky → note edge = %+v", e)
			}
		case taskCard.ID:
			if e.Arrow != "both" {
				t.Errorf("task ↔ note edge = %+v", e)
			}
		}
	}

	list := invokeJSON[[]map[string]string](t, r, "list_canvases", `{"query":"q3"}`)
	if len(list) != 1 || list[0]["id"] != cv.ID || list[0]["wikilink"] != "[[canvas:"+cv.ID+"]]" {
		t.Errorf("list_canvases = %+v", list)
	}
	if list := invokeJSON[[]map[string]string](t, r, "list_canvases", `{"query":"roadmap"}`); len(list) != 0 {
		t.Errorf("name filter let %+v through", list)
	}

	out, err := r.Invoke(context.Background(), "render_canvas", json.RawMessage(`{"id":"`+cv.ID+`"}`))
	if err != nil || !strings.Contains(out, "[[canvas:"+cv.ID+"]]") {
		t.Errorf("render_canvas = %q, %v", out, err)
	}
	for _, tool := range []string{"get_canvas", "render_canvas"} {
		if _, err := r.Invoke(context.Background(), tool, json.RawMessage(`{"id":"nope"}`)); err == nil || !strings.Contains(err.Error(), "list_canvases") {
			t.Errorf("%s with a bad id: %v", tool, err)
		}
	}
}

func TestRenderTask(t *testing.T) {
	s := newTestStore(t)
	r := NewStoreRegistry(s)
	task, err := s.Tasks.Create(store.CreateTaskInput{Title: "Water plants"})
	if err != nil {
		t.Fatal(err)
	}
	out, err := r.Invoke(context.Background(), "render_task", json.RawMessage(`{"id":"`+task.ID+`"}`))
	if err != nil || !strings.Contains(out, "[[task:"+task.ID+"]]") {
		t.Errorf("render_task = %q, %v", out, err)
	}
	if _, err := r.Invoke(context.Background(), "render_task", json.RawMessage(`{"id":"nope"}`)); err == nil {
		t.Error("render_task with a bad id should fail")
	}
}

// TestRenderGraph checks render_graph confirms the graph and names what's connected, so the
// model comments on real links instead of inventing them.
func TestRenderGraph(t *testing.T) {
	s := newTestStore(t)
	r := NewStoreRegistry(s)
	ctx := context.Background()
	b, err := s.Notes.Create(store.CreateNoteInput{Title: "Pricing"})
	if err != nil {
		t.Fatal(err)
	}
	a, err := s.Notes.Create(store.CreateNoteInput{Title: "Launch", ContentMD: "See [[note:" + b.ID + "]]."})
	if err != nil {
		t.Fatal(err)
	}
	lonely, err := s.Notes.Create(store.CreateNoteInput{Title: "Stray thought"})
	if err != nil {
		t.Fatal(err)
	}

	out, err := r.Invoke(ctx, "render_graph", json.RawMessage(`{"type":"note","id":"`+a.ID+`"}`))
	if err != nil || !strings.Contains(out, "[[note:"+b.ID+"]]") || !strings.Contains(out, `"Pricing"`) {
		t.Errorf("render_graph = %q, %v", out, err)
	}
	out, err = r.Invoke(ctx, "render_graph", json.RawMessage(`{"type":"note","id":"`+lonely.ID+`","depth":9}`))
	if err != nil || !strings.Contains(out, "stands alone") {
		t.Errorf("render_graph of an unlinked note = %q, %v", out, err)
	}
	for _, bad := range []string{`{"type":"note","id":"nope"}`, `{"type":"habit","id":"` + a.ID + `"}`} {
		if _, err := r.Invoke(ctx, "render_graph", json.RawMessage(bad)); err == nil {
			t.Errorf("render_graph(%s) should fail", bad)
		}
	}
}
