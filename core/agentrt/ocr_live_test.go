//go:build !js

package agentrt

import (
	"context"
	"os"
	"strings"
	"testing"

	"companion/core/ink"
)

// strokeLetters draws block capitals as pen strokes, the way a hand would: each letter a few
// straight strokes, 30px tall, left to right.
func strokeLetters(word string) *ink.Group {
	shapes := map[rune][][][2]float64{
		'H': {{{0, 0}, {0, 30}}, {{18, 0}, {18, 30}}, {{0, 15}, {18, 15}}},
		'E': {{{18, 0}, {0, 0}, {0, 30}, {18, 30}}, {{0, 15}, {14, 15}}},
		'L': {{{0, 0}, {0, 30}, {16, 30}}},
		'O': {{{9, 0}, {16, 4}, {18, 15}, {16, 26}, {9, 30}, {2, 26}, {0, 15}, {2, 4}, {9, 0}}},
	}
	g := &ink.Group{ID: "live", Anchor: ink.Anchor{Page: true}}
	x := 0.0
	for _, r := range word {
		for _, s := range shapes[r] {
			pts := make([]ink.Point, len(s))
			for i, p := range s {
				pts[i] = ink.Point{X: p[0] + x, Y: p[1], P: .5}
			}
			// Densify so the stroke looks sampled, as real input is.
			var dense []ink.Point
			for i := 0; i+1 < len(pts); i++ {
				for k := 0; k < 8; k++ {
					f := float64(k) / 8
					dense = append(dense, ink.Point{X: pts[i].X + f*(pts[i+1].X-pts[i].X), Y: pts[i].Y + f*(pts[i+1].Y-pts[i].Y), P: .5})
				}
			}
			dense = append(dense, pts[len(pts)-1])
			g.Strokes = append(g.Strokes, ink.Stroke{Tool: "pen", Width: 4, Points: dense})
		}
		x += 28
	}
	return g
}

// TestRecognizeInkLive runs Apple Vision on drawn strokes through the real helper.
func TestRecognizeInkLive(t *testing.T) {
	helper := os.Getenv("COMPANION_FM_HELPER")
	if helper == "" {
		t.Skip("set COMPANION_FM_HELPER to run Apple Vision text recognition")
	}
	r, ok := ink.Render(strokeLetters("HELLO"))
	if !ok {
		t.Fatal("nothing rendered")
	}
	fm := &FoundationModels{HelperPath: helper}
	res, err := fm.RecognizeInk(context.Background(), [][]byte{r.PNG})
	if err != nil {
		t.Fatal(err)
	}
	if len(res) != 1 || len(res[0]) == 0 {
		t.Fatalf("results = %+v", res)
	}
	if got := strings.ToUpper(strings.ReplaceAll(res[0][0].Text, " ", "")); got != "HELLO" {
		t.Errorf("read %q, want HELLO", res[0][0].Text)
	}
	if b := res[0][0].Box; b.W <= 0 || b.Y < 0 || b.Y > 1 {
		t.Errorf("box = %+v", b)
	}
}
