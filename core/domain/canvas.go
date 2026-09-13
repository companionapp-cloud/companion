package domain

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Canvases (PLAN-canvases.md). A canvas is an infinite 2D surface holding nodes — sticky
// text, colored groups, embedded notes/tasks/events/images, and link previews — joined by
// arrows. It is three synced entities rather than one JSON blob: a Canvas row (name + trash
// state), its CanvasNodes, and its CanvasEdges. Per-row sync means two devices editing
// different nodes of the same canvas merge cleanly instead of forking a "conflicted copy"
// of the whole board.
//
// Coordinates are absolute canvas units with a top-left origin (x, y, width, height), the
// same frame React Flow and the JSON Canvas spec use. Groups do not own their children:
// containment is geometric (a node whose bounds fall inside a group's bounds moves with it),
// so no parent pointer has to be kept consistent across devices.

// Canvas is the board itself. It is trashable like a note (DeletingAt), and a member of
// projects through project_members (entity_type 'canvas').
type Canvas struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	CreatedAt  time.Time  `json:"createdAt"`
	UpdatedAt  time.Time  `json:"updatedAt"`
	DeletingAt *time.Time `json:"deletingAt,omitempty"`
	DeletedAt  *time.Time `json:"deletedAt,omitempty"`
	Version    int64      `json:"version"`
	Dirty      bool       `json:"dirty"`
}

// Node kinds. text/group/link mirror the JSON Canvas spec; note/task/event/image embed
// app entities by reference (RefType + RefID), never by copying their content.
const (
	CanvasNodeText  = "text"  // sticky note: {"text": markdown}
	CanvasNodeGroup = "group" // labeled rect behind other nodes: {"label": string}
	CanvasNodeNote  = "note"  // ref → note
	CanvasNodeTask  = "task"  // ref → task
	CanvasNodeEvent = "event" // ref → calendar_events; data caches {"title","startsAt"}
	CanvasNodeImage = "image" // ref → document (image bytes)
	CanvasNodeLink  = "link"  // {"url","title","description","imageUrl","siteName","faviconUrl"}
)

// CanvasNodeKinds is the allowed set of node kinds.
var CanvasNodeKinds = map[string]bool{
	CanvasNodeText: true, CanvasNodeGroup: true, CanvasNodeNote: true, CanvasNodeTask: true,
	CanvasNodeEvent: true, CanvasNodeImage: true, CanvasNodeLink: true,
}

// canvasRefTypeForKind is the entity type a reference-kind node must point at.
var canvasRefTypeForKind = map[string]string{
	CanvasNodeNote:  NodeNote,
	CanvasNodeTask:  NodeTask,
	CanvasNodeEvent: "event",
	CanvasNodeImage: NodeDocument,
}

// CanvasRefType returns the ref_type a node kind requires, or "" for self-contained kinds.
func CanvasRefType(kind string) string { return canvasRefTypeForKind[kind] }

// MaxCanvasNodeData caps data_json so a runaway sticky can't bloat sync payloads.
const MaxCanvasNodeData = 64 * 1024

// CanvasNode is one item on a canvas. Data carries the kind-specific content (encrypted
// on the wire); geometry, kind, color and the entity reference stay plaintext — the same
// split project_members makes for entity ids.
type CanvasNode struct {
	ID       string  `json:"id"`
	CanvasID string  `json:"canvasId"`
	Kind     string  `json:"kind"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	Width    float64 `json:"width"`
	Height   float64 `json:"height"`
	// Z orders overlapping nodes; groups default below everything else.
	Z     int     `json:"z"`
	Color *string `json:"color,omitempty"`
	// RefType/RefID point at the embedded entity for note/task/event/image nodes.
	RefType   *string         `json:"refType,omitempty"`
	RefID     *string         `json:"refId,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
	CreatedAt time.Time       `json:"createdAt"`
	UpdatedAt time.Time       `json:"updatedAt"`
	DeletedAt *time.Time      `json:"deletedAt,omitempty"`
	Version   int64           `json:"version"`
	Dirty     bool            `json:"dirty"`
}

// Edge sides and ends.
const (
	CanvasSideTop    = "top"
	CanvasSideRight  = "right"
	CanvasSideBottom = "bottom"
	CanvasSideLeft   = "left"

	CanvasEndNone        = "none"
	CanvasEndArrow       = "arrow"       // open chevron
	CanvasEndArrowFilled = "arrowFilled" // solid triangle
	CanvasEndDot         = "dot"         // hollow circle
	CanvasEndDotFilled   = "dotFilled"   // solid circle

	// Line styles: a bezier curve, orthogonal steps, or a direct line.
	CanvasStyleCurved   = "curved"
	CanvasStyleStep     = "step"
	CanvasStyleStraight = "straight"
)

var canvasSides = map[string]bool{CanvasSideTop: true, CanvasSideRight: true, CanvasSideBottom: true, CanvasSideLeft: true}
var canvasEnds = map[string]bool{CanvasEndNone: true, CanvasEndArrow: true, CanvasEndArrowFilled: true, CanvasEndDot: true, CanvasEndDotFilled: true}
var canvasStyles = map[string]bool{CanvasStyleCurved: true, CanvasStyleStep: true, CanvasStyleStraight: true}

// CanvasEdge is a connector between two nodes of the same canvas. A nil side means
// "auto": the renderer picks the nearest pair of sides at draw time.
type CanvasEdge struct {
	ID         string     `json:"id"`
	CanvasID   string     `json:"canvasId"`
	FromNodeID string     `json:"fromNodeId"`
	ToNodeID   string     `json:"toNodeId"`
	FromSide   *string    `json:"fromSide,omitempty"`
	ToSide     *string    `json:"toSide,omitempty"`
	FromEnd    string     `json:"fromEnd"`
	ToEnd      string     `json:"toEnd"`
	Style      string     `json:"style"`
	Label      string     `json:"label"`
	Color      *string    `json:"color,omitempty"`
	CreatedAt  time.Time  `json:"createdAt"`
	UpdatedAt  time.Time  `json:"updatedAt"`
	DeletedAt  *time.Time `json:"deletedAt,omitempty"`
	Version    int64      `json:"version"`
	Dirty      bool       `json:"dirty"`
}

// ErrInvalidCanvas is returned when a canvas, node, or edge fails validation.
var ErrInvalidCanvas = errors.New("invalid canvas")

// Validate checks the invariants that must hold before a canvas is persisted.
func (c *Canvas) Validate() error {
	if strings.TrimSpace(c.ID) == "" {
		return errors.Join(ErrInvalidCanvas, errors.New("id is required"))
	}
	return nil
}

// Validate checks a node's invariants: a known kind, positive size, a reference for
// reference kinds (and none for self-contained kinds), and a JSON-object data payload.
func (n *CanvasNode) Validate() error {
	if strings.TrimSpace(n.ID) == "" {
		return errors.Join(ErrInvalidCanvas, errors.New("node id is required"))
	}
	if strings.TrimSpace(n.CanvasID) == "" {
		return errors.Join(ErrInvalidCanvas, errors.New("node canvasId is required"))
	}
	if !CanvasNodeKinds[n.Kind] {
		return errors.Join(ErrInvalidCanvas, errors.New("unknown node kind "+n.Kind))
	}
	if n.Width <= 0 || n.Height <= 0 {
		return errors.Join(ErrInvalidCanvas, errors.New("node width and height must be positive"))
	}
	if want := CanvasRefType(n.Kind); want != "" {
		if n.RefType == nil || *n.RefType != want || n.RefID == nil || strings.TrimSpace(*n.RefID) == "" {
			return errors.Join(ErrInvalidCanvas, errors.New(n.Kind+" node must reference a "+want))
		}
	} else if n.RefType != nil || n.RefID != nil {
		return errors.Join(ErrInvalidCanvas, errors.New(n.Kind+" node cannot carry a reference"))
	}
	if len(n.Data) > MaxCanvasNodeData {
		return errors.Join(ErrInvalidCanvas, errors.New("node data too large"))
	}
	if len(n.Data) > 0 && string(n.Data) != "null" {
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(n.Data, &obj); err != nil {
			return errors.Join(ErrInvalidCanvas, errors.New("node data must be a JSON object"))
		}
	}
	return nil
}

// Validate checks an edge's invariants: two distinct endpoints and known sides/ends.
func (e *CanvasEdge) Validate() error {
	if strings.TrimSpace(e.ID) == "" {
		return errors.Join(ErrInvalidCanvas, errors.New("edge id is required"))
	}
	if strings.TrimSpace(e.CanvasID) == "" {
		return errors.Join(ErrInvalidCanvas, errors.New("edge canvasId is required"))
	}
	if strings.TrimSpace(e.FromNodeID) == "" || strings.TrimSpace(e.ToNodeID) == "" {
		return errors.Join(ErrInvalidCanvas, errors.New("edge endpoints are required"))
	}
	if e.FromNodeID == e.ToNodeID {
		return errors.Join(ErrInvalidCanvas, errors.New("edge cannot connect a node to itself"))
	}
	if e.FromSide != nil && !canvasSides[*e.FromSide] {
		return errors.Join(ErrInvalidCanvas, errors.New("unknown fromSide"))
	}
	if e.ToSide != nil && !canvasSides[*e.ToSide] {
		return errors.Join(ErrInvalidCanvas, errors.New("unknown toSide"))
	}
	if !canvasEnds[e.FromEnd] || !canvasEnds[e.ToEnd] {
		return errors.Join(ErrInvalidCanvas, errors.New("edge ends must be none, arrow, arrowFilled, dot, or dotFilled"))
	}
	if !canvasStyles[e.Style] {
		return errors.Join(ErrInvalidCanvas, errors.New("edge style must be curved, step, or straight"))
	}
	return nil
}

// SyncEntity implementations (PLAN §7).
func (c *Canvas) SyncID() string           { return c.ID }
func (c *Canvas) SyncVersion() int64       { return c.Version }
func (c *Canvas) SyncUpdatedAt() time.Time { return c.UpdatedAt }
func (c *Canvas) SyncDeleted() bool        { return c.DeletedAt != nil }
func (c *Canvas) SyncDirty() bool          { return c.Dirty }

func (n *CanvasNode) SyncID() string           { return n.ID }
func (n *CanvasNode) SyncVersion() int64       { return n.Version }
func (n *CanvasNode) SyncUpdatedAt() time.Time { return n.UpdatedAt }
func (n *CanvasNode) SyncDeleted() bool        { return n.DeletedAt != nil }
func (n *CanvasNode) SyncDirty() bool          { return n.Dirty }

func (e *CanvasEdge) SyncID() string           { return e.ID }
func (e *CanvasEdge) SyncVersion() int64       { return e.Version }
func (e *CanvasEdge) SyncUpdatedAt() time.Time { return e.UpdatedAt }
func (e *CanvasEdge) SyncDeleted() bool        { return e.DeletedAt != nil }
func (e *CanvasEdge) SyncDirty() bool          { return e.Dirty }
