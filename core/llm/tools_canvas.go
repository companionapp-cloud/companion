package llm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"companion/core/domain"
	"companion/core/store"
)

// Canvas tools (PLAN-canvases.md): list the user's boards, read one the way the model needs it —
// what each card says, which group it sits in, how the arrows connect them — and show one inline
// in the chat.

// maxCanvasNodes bounds one get_canvas result; a larger board is cut in reading order.
const maxCanvasNodes = 400

// readingRow is the band height, in canvas units, within which cards count as one row when a
// board is read top to bottom, left to right — so a card a few units higher than its neighbor
// doesn't jump the queue.
const readingRow = 80

// canvasNodeOut is one card of a board as the model reads it. Geometry is rounded canvas units.
type canvasNodeOut struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	// Text is a sticky note's text, or a group's label.
	Text     string `json:"text,omitempty"`
	Title    string `json:"title,omitempty"`
	Excerpt  string `json:"excerpt,omitempty"`
	Status   string `json:"status,omitempty"`
	Due      string `json:"due,omitempty"`
	Start    string `json:"start,omitempty"`
	End      string `json:"end,omitempty"`
	Location string `json:"location,omitempty"`
	URL      string `json:"url,omitempty"`
	Site     string `json:"site,omitempty"`
	Filename string `json:"filename,omitempty"`
	Wikilink string `json:"wikilink,omitempty"`
	EventID  string `json:"eventId,omitempty"`
	// Missing marks an embedded note, task, event or image that has since been deleted.
	Missing bool `json:"missing,omitempty"`
	// Group is the id of the innermost group the card sits inside.
	Group  string `json:"group,omitempty"`
	X      int    `json:"x"`
	Y      int    `json:"y"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

// canvasEdgeOut is an arrow between two cards.
type canvasEdgeOut struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Label string `json:"label,omitempty"`
	// Arrow says which way it points: "forward" (from → to), "backward", "both" or "none".
	Arrow string `json:"arrow"`
}

func addCanvasTools(r *Registry, s *store.Store) {
	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "list_canvases",
			Description: "List the user's canvases — whiteboards of cards, sticky notes, groups and arrows — most recently changed first, optionally filtered by name. Call this when the user mentions a canvas, board, whiteboard, map or diagram, or asks what canvases they have; search_notes does not search canvases. Then read one with get_canvas.",
			Schema: json.RawMessage(`{
				"type":"object",
				"additionalProperties":false,
				"properties":{
					"query":{"type":"string","description":"Only canvases whose name contains this text (case-insensitive)."},
					"limit":{"type":"integer","description":"Max results (default 50)."}
				}
			}`),
		},
		Handler: func(_ context.Context, args json.RawMessage) (string, error) {
			var a struct {
				Query string `json:"query"`
				Limit int    `json:"limit"`
			}
			_ = json.Unmarshal(args, &a)
			canvases, err := s.Canvases.List()
			if err != nil {
				return "", err
			}
			limit := a.Limit
			if limit <= 0 || limit > 200 {
				limit = 50
			}
			query := strings.ToLower(strings.TrimSpace(a.Query))
			out := []map[string]string{}
			for _, c := range canvases {
				if query != "" && !strings.Contains(strings.ToLower(c.Name), query) {
					continue
				}
				out = append(out, map[string]string{
					"id": c.ID, "name": canvasName(c), "updatedAt": c.UpdatedAt.In(time.Local).Format(time.RFC3339),
					"wikilink": fmt.Sprintf("[[%s:%s]]", domain.NodeCanvas, c.ID),
				})
				if len(out) == limit {
					break
				}
			}
			return jsonResult(out)
		},
	})

	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "get_canvas",
			Description: "Read a canvas in full: every card — sticky-note text, embedded notes/tasks/events with their titles, links, images — the group each sits in, and the arrows between them with their labels and direction. Call this before summarizing, answering questions about, or reasoning over a canvas; never guess what's on one. Nodes come in reading order (top to bottom, left to right) with their canvas coordinates; `group` is the id of the group a card sits inside. Follow an embedded note's or task's wikilink with get_note / get_task for its full content. Get the id from list_canvases.",
			Schema:      json.RawMessage(`{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string"}},"required":["id"]}`),
		},
		Handler: func(_ context.Context, args json.RawMessage) (string, error) {
			var a struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(args, &a); err != nil {
				return "", err
			}
			c, err := canvasByID(s, a.ID)
			if err != nil {
				return "", err
			}
			nodes, err := s.CanvasNodes.ListForCanvas(c.ID)
			if err != nil {
				return "", err
			}
			edges, err := s.CanvasEdges.ListForCanvas(c.ID)
			if err != nil {
				return "", err
			}
			sortReadingOrder(nodes)
			truncated := len(nodes) > maxCanvasNodes
			if truncated {
				nodes = nodes[:maxCanvasNodes]
			}
			groups := innermostGroups(nodes)
			outNodes := make([]canvasNodeOut, 0, len(nodes))
			kept := make(map[string]bool, len(nodes))
			for _, n := range nodes {
				o, err := canvasNode(s, n)
				if err != nil {
					return "", err
				}
				o.Group = groups[n.ID]
				outNodes = append(outNodes, o)
				kept[n.ID] = true
			}
			outEdges := []canvasEdgeOut{}
			for _, e := range edges {
				if kept[e.FromNodeID] && kept[e.ToNodeID] {
					outEdges = append(outEdges, canvasEdgeOut{From: e.FromNodeID, To: e.ToNodeID, Label: e.Label, Arrow: arrowDirection(e)})
				}
			}
			return jsonResult(map[string]any{
				"id": c.ID, "name": canvasName(c), "wikilink": fmt.Sprintf("[[%s:%s]]", domain.NodeCanvas, c.ID),
				"nodes": outNodes, "edges": outEdges, "truncated": truncated,
			})
		},
	})

	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "render_canvas",
			Description: "Show the user an inline, clickable miniature of a canvas in the chat — its cards, groups and arrows laid out as they are on the board. Prefer this over describing a canvas's layout in words when the user wants to see a canvas, or when you point them to one. Clicking it opens the full canvas. Get the id from list_canvases. This does not change the canvas.",
			Schema:      json.RawMessage(`{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string"}},"required":["id"]}`),
		},
		Handler: func(_ context.Context, args json.RawMessage) (string, error) {
			var a struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(args, &a); err != nil {
				return "", err
			}
			c, err := canvasByID(s, a.ID)
			if err != nil {
				return "", err
			}
			return fmt.Sprintf("An inline preview of [[%s:%s]] (%q) is now shown to the user in the chat. Do not describe its layout again — just add any commentary.", domain.NodeCanvas, c.ID, canvasName(c)), nil
		},
	})
}

func canvasByID(s *store.Store, id string) (*domain.Canvas, error) {
	c, err := s.Canvases.Get(id)
	if errors.Is(err, store.ErrNotFound) {
		return nil, fmt.Errorf("no canvas with id %q — use list_canvases to find it", id)
	}
	return c, err
}

func canvasName(c *domain.Canvas) string {
	if strings.TrimSpace(c.Name) == "" {
		return "Untitled canvas"
	}
	return c.Name
}

// sortReadingOrder orders nodes top to bottom in readingRow bands, then left to right.
func sortReadingOrder(nodes []*domain.CanvasNode) {
	band := func(n *domain.CanvasNode) int { return int(math.Floor(n.Y / readingRow)) }
	sort.SliceStable(nodes, func(i, j int) bool {
		if bi, bj := band(nodes[i]), band(nodes[j]); bi != bj {
			return bi < bj
		}
		if nodes[i].X != nodes[j].X {
			return nodes[i].X < nodes[j].X
		}
		return nodes[i].ID < nodes[j].ID
	})
}

// innermostGroups maps each node to the smallest group that wholly contains it. Containment is
// geometric, exactly as the canvas decides what a group drags along (canvas/geometry.ts).
func innermostGroups(nodes []*domain.CanvasNode) map[string]string {
	out := map[string]string{}
	for _, n := range nodes {
		best, bestArea := "", math.Inf(1)
		for _, g := range nodes {
			if g.Kind != domain.CanvasNodeGroup || g.ID == n.ID || !containsNode(g, n) {
				continue
			}
			if a := g.Width * g.Height; a < bestArea {
				best, bestArea = g.ID, a
			}
		}
		if best != "" {
			out[n.ID] = best
		}
	}
	return out
}

// containsNode reports whether inner lies entirely inside outer (touching edges count).
func containsNode(outer, inner *domain.CanvasNode) bool {
	return inner.X >= outer.X && inner.Y >= outer.Y &&
		inner.X+inner.Width <= outer.X+outer.Width && inner.Y+inner.Height <= outer.Y+outer.Height
}

// arrowDirection reads an edge's two ends as the way it points.
func arrowDirection(e *domain.CanvasEdge) string {
	isArrow := func(end string) bool { return end == domain.CanvasEndArrow || end == domain.CanvasEndArrowFilled }
	switch from, to := isArrow(e.FromEnd), isArrow(e.ToEnd); {
	case from && to:
		return "both"
	case to:
		return "forward"
	case from:
		return "backward"
	default:
		return "none"
	}
}

// canvasNode renders one node for the model, resolving what an embedded card points at.
func canvasNode(s *store.Store, n *domain.CanvasNode) (canvasNodeOut, error) {
	o := canvasNodeOut{
		ID: n.ID, Kind: n.Kind,
		X: int(math.Round(n.X)), Y: int(math.Round(n.Y)), Width: int(math.Round(n.Width)), Height: int(math.Round(n.Height)),
	}
	data := map[string]any{}
	if len(n.Data) > 0 {
		_ = json.Unmarshal(n.Data, &data)
	}
	text := func(key string) string {
		v, _ := data[key].(string)
		return v
	}
	ref := ""
	if n.RefID != nil {
		ref = *n.RefID
	}
	switch n.Kind {
	case domain.CanvasNodeText:
		o.Text = clipRunes(text("text"), 2000)
	case domain.CanvasNodeGroup:
		o.Text = text("label")
	case domain.CanvasNodeLink:
		o.URL, o.Title, o.Site = text("url"), text("title"), text("siteName")
		o.Excerpt = clipRunes(text("description"), 300)
	case domain.CanvasNodeNote:
		o.Wikilink = fmt.Sprintf("[[%s:%s]]", domain.NodeNote, ref)
		note, err := s.Notes.Get(ref)
		switch {
		case errors.Is(err, store.ErrNotFound):
			o.Missing = true
		case err != nil:
			return o, err
		default:
			o.Title = note.Title
			o.Excerpt = clipRunes(strings.Join(strings.Fields(note.ContentMD), " "), 400)
		}
	case domain.CanvasNodeTask:
		o.Wikilink = fmt.Sprintf("[[%s:%s]]", domain.NodeTask, ref)
		task, err := s.Tasks.Get(ref)
		switch {
		case errors.Is(err, store.ErrNotFound):
			o.Missing = true
		case err != nil:
			return o, err
		default:
			o.Title, o.Status = task.Title, task.Status
			if task.DueAt != nil {
				o.Due = task.DueAt.In(time.Local).Format(time.RFC3339)
			}
		}
	case domain.CanvasNodeEvent:
		o.EventID = ref
		ev, err := s.CalendarEvents.GetLive(ref)
		switch {
		case errors.Is(err, store.ErrNotFound):
			// Feeds re-expand events away; the card keeps the copy cached when it was placed.
			o.Missing = true
			o.Title, o.Start = text("title"), text("startsAt")
		case err != nil:
			return o, err
		default:
			o.Title = ev.Title
			o.Start, o.End = whenOut(ev.StartsAt, ev.EndsAt, ev.AllDay)
			if ev.Location != nil {
				o.Location = *ev.Location
			}
		}
	case domain.CanvasNodeImage:
		doc, err := s.Documents.Get(ref)
		switch {
		case errors.Is(err, store.ErrNotFound):
			o.Missing = true
		case err != nil:
			return o, err
		default:
			o.Filename = doc.Filename
		}
		o.Text = text("alt")
	}
	return o, nil
}
