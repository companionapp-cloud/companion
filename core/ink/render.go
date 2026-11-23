package ink

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"math"
)

// Box is a rectangle: in ink coordinates (CSS px) for groups, or normalized to an image for
// OCR results.
type Box struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

func (b Box) right() float64  { return b.X + b.W }
func (b Box) bottom() float64 { return b.Y + b.H }

func (b Box) union(o Box) Box {
	if b.W == 0 && b.H == 0 {
		return o
	}
	x, y := math.Min(b.X, o.X), math.Min(b.Y, o.Y)
	return Box{x, y, math.Max(b.right(), o.right()) - x, math.Max(b.bottom(), o.bottom()) - y}
}

// Intersects reports whether two boxes overlap.
func (b Box) Intersects(o Box) bool {
	return b.X < o.right() && o.X < b.right() && b.Y < o.bottom() && o.Y < b.bottom()
}

// Bounds is the area a group's pen strokes cover, widths included; ok=false when it has none.
func Bounds(groups ...*Group) (Box, bool) {
	var box Box
	ok := false
	for _, g := range groups {
		for _, s := range g.Strokes {
			if s.Tool != "pen" {
				continue
			}
			r := s.Width / 2
			for _, p := range s.Points {
				pb := Box{p.X - r, p.Y - r, 2 * r, 2 * r}
				if !ok {
					box, ok = pb, true
				} else {
					box = box.union(pb)
				}
			}
		}
	}
	return box, ok
}

// Rendering is groups drawn as a PNG. Box is the ink area the image covers and Scale its
// pixels per CSS px, so an image point (px, py) is ink point (Box.X+px/Scale, Box.Y+py/Scale).
type Rendering struct {
	PNG   []byte
	Box   Box
	Scale float64
	W, H  int
}

// Render limits: enough resolution for an OCR engine without sending a huge image.
const (
	renderPadding  = 16.0 // CSS px around the ink
	renderScale    = 2.0
	renderMaxScale = 4.0
	renderMinH     = 96.0   // small ink is drawn larger, up to renderMaxScale
	renderMaxSide  = 2048.0 // large ink is drawn smaller
)

// Render draws the groups' pen strokes black on white, cropped to the ink. Highlighter strokes
// are left out: they mark text rather than write it. Groups must share a coordinate space
// (one note group, or any groups on one notebook page). ok=false when there is nothing to draw.
func Render(groups ...*Group) (*Rendering, bool) {
	ink, ok := Bounds(groups...)
	if !ok {
		return nil, false
	}
	box := Box{ink.X - renderPadding, ink.Y - renderPadding, ink.W + 2*renderPadding, ink.H + 2*renderPadding}
	scale := renderScale
	if box.H*scale < renderMinH {
		scale = math.Min(renderMaxScale, renderMinH/box.H)
	}
	if side := math.Max(box.W, box.H) * scale; side > renderMaxSide {
		scale *= renderMaxSide / side
	}
	w, h := int(math.Ceil(box.W*scale)), int(math.Ceil(box.H*scale))
	img := image.NewGray(image.Rect(0, 0, w, h))
	for i := range img.Pix {
		img.Pix[i] = 255
	}
	for _, g := range groups {
		for _, s := range g.Strokes {
			if s.Tool == "pen" {
				drawStroke(img, s, box, scale)
			}
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, false
	}
	return &Rendering{PNG: buf.Bytes(), Box: box, Scale: scale, W: w, H: h}, true
}

// radius approximates perfect-freehand's pen outline: thinner under light pressure. A stroke
// without real pressure is drawn at a steady medium width.
func radius(s Stroke, p float64) float64 {
	if s.Sim {
		p = 0.5
	}
	r := s.Width / 2 * (1 - 0.55*(0.5-p))
	return math.Max(r, 0.6)
}

// drawStroke paints a stroke as a chain of anti-aliased capsules.
func drawStroke(img *image.Gray, s Stroke, box Box, scale float64) {
	pts := s.Points
	if len(pts) == 1 {
		pts = []Point{pts[0], pts[0]}
	}
	for i := 0; i+1 < len(pts); i++ {
		a, b := pts[i], pts[i+1]
		ax, ay := (a.X-box.X)*scale, (a.Y-box.Y)*scale
		bx, by := (b.X-box.X)*scale, (b.Y-box.Y)*scale
		ra, rb := radius(s, a.P)*scale, radius(s, b.P)*scale
		capsule(img, ax, ay, bx, by, ra, rb)
	}
}

// capsule darkens the pixels within a segment's (linearly varying) radius, with a one-pixel
// soft edge.
func capsule(img *image.Gray, ax, ay, bx, by, ra, rb float64) {
	rmax := math.Max(ra, rb) + 1
	x0, x1 := int(math.Floor(math.Min(ax, bx)-rmax)), int(math.Ceil(math.Max(ax, bx)+rmax))
	y0, y1 := int(math.Floor(math.Min(ay, by)-rmax)), int(math.Ceil(math.Max(ay, by)+rmax))
	bounds := img.Bounds()
	dx, dy := bx-ax, by-ay
	l2 := dx*dx + dy*dy
	for y := max(y0, bounds.Min.Y); y < min(y1, bounds.Max.Y); y++ {
		for x := max(x0, bounds.Min.X); x < min(x1, bounds.Max.X); x++ {
			px, py := float64(x)+0.5, float64(y)+0.5
			t := 0.0
			if l2 > 0 {
				t = math.Max(0, math.Min(1, ((px-ax)*dx+(py-ay)*dy)/l2))
			}
			cx, cy := ax+t*dx, ay+t*dy
			d := math.Hypot(px-cx, py-cy)
			r := ra + t*(rb-ra)
			cov := math.Max(0, math.Min(1, r+0.5-d))
			if cov == 0 {
				continue
			}
			v := uint8(math.Round(255 * (1 - cov)))
			if v < img.GrayAt(x, y).Y {
				img.SetGray(x, y, color.Gray{Y: v})
			}
		}
	}
}
