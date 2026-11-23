// Package ink reads the ink groups the editor stores (PLAN-drawing.md, PLAN-notebooks.md) so
// tools can turn handwriting into text: it decodes a group's strokes, draws them as a PNG a
// vision model or an OCR engine can read, and places recognized text in a note's markdown at
// the point the group is pinned to.
//
// The stored format is owned by the editor (packages/editor/src/ink/types.ts and stroke.ts);
// this package mirrors it read-only and must stay in step with it.
package ink

import (
	"context"
	"encoding/json"
	"errors"
)

// Anchor pins a group to the text: the text on either side of its point and the point's
// offset when it was written. Free ink was drawn in empty space beside a line; page ink is
// fixed to a notebook sheet and its strokes are in page coordinates.
type Anchor struct {
	Before string `json:"before"`
	After  string `json:"after"`
	Offset int    `json:"offset"`
	Free   bool   `json:"free,omitempty"`
	Page   bool   `json:"page,omitempty"`
}

// Point is one decoded input sample: x, y in CSS px (relative to the group's anchor point, or
// the sheet for page ink) and pressure 0–1.
type Point struct{ X, Y, P float64 }

// Stroke is one decoded stroke.
type Stroke struct {
	ID    string
	Tool  string // "pen" | "highlighter"
	Color string
	Width float64
	// Sim marks a stroke without real pressure (mouse, finger).
	Sim    bool
	Points []Point
}

// Group is one decoded ink group.
type Group struct {
	ID      string
	Anchor  Anchor
	Strokes []Stroke
}

// ErrUnsupported is returned for a payload this version doesn't understand.
var ErrUnsupported = errors.New("unsupported ink payload")

type wireStroke struct {
	ID     string    `json:"id"`
	Tool   string    `json:"tool"`
	Color  string    `json:"color"`
	Width  float64   `json:"width"`
	Sim    bool      `json:"sim"`
	Points []float64 `json:"points"`
}

type wireGroup struct {
	V       int          `json:"v"`
	Anchor  *Anchor      `json:"anchor"`
	Strokes []wireStroke `json:"strokes"`
}

// Parse decodes one stored group payload, mirroring parseInkGroupData in the editor: strokes
// that aren't pen or highlighter, or have no points, are dropped.
func Parse(id string, data json.RawMessage) (*Group, error) {
	var w wireGroup
	if err := json.Unmarshal(data, &w); err != nil {
		return nil, errors.Join(ErrUnsupported, err)
	}
	if w.V != 1 || w.Anchor == nil {
		return nil, ErrUnsupported
	}
	g := &Group{ID: id, Anchor: *w.Anchor}
	for _, s := range w.Strokes {
		if (s.Tool != "pen" && s.Tool != "highlighter") || len(s.Points) < 3 {
			continue
		}
		g.Strokes = append(g.Strokes, Stroke{
			ID: s.ID, Tool: s.Tool, Color: s.Color, Width: s.Width, Sim: s.Sim, Points: DecodePoints(s.Points),
		})
	}
	return g, nil
}

// Stored points are delta-encoded integers: x/y in tenths of a CSS px, pressure in percent.
const (
	xyScale       = 10
	pressureScale = 100
)

// DecodePoints undoes the editor's encodePoints.
func DecodePoints(flat []float64) []Point {
	out := make([]Point, 0, len(flat)/3)
	var x, y, p float64
	for i := 0; i+2 < len(flat); i += 3 {
		x += flat[i]
		y += flat[i+1]
		p += flat[i+2]
		out = append(out, Point{x / xyScale, y / xyScale, p / pressureScale})
	}
	return out
}

// Writing reports whether a group holds pen strokes: highlighter marks text rather than
// writing it, so a highlighter-only group has nothing to read.
func (g *Group) Writing() bool {
	for _, s := range g.Strokes {
		if s.Tool == "pen" {
			return true
		}
	}
	return false
}

// Line is one line of text an OCR engine found in an image. Box is normalized to the image
// (0–1, origin top-left).
type Line struct {
	Text       string  `json:"text"`
	Confidence float64 `json:"confidence"`
	Box        Box     `json:"box"`
}

// Recognizer reads handwriting in PNG images, returning the lines found in each image in
// reading order. Apple Vision through the desktop's companion-fm helper is one
// (core/agentrt).
type Recognizer interface {
	RecognizeInk(ctx context.Context, images [][]byte) ([][]Line, error)
}
