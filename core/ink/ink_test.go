package ink

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image/png"
	"strings"
	"testing"
)

// encode mirrors the editor's encodePoints, for building fixtures.
func encode(pts ...Point) []float64 {
	var out []float64
	var px, py, pp float64
	for _, p := range pts {
		ix, iy, ip := float64(int(p.X*10)), float64(int(p.Y*10)), float64(int(p.P*100))
		out = append(out, ix-px, iy-py, ip-pp)
		px, py, pp = ix, iy, ip
	}
	return out
}

func groupJSON(anchor string, strokes ...string) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"v":1,"anchor":%s,"strokes":[%s]}`, anchor, strings.Join(strokes, ",")))
}

func strokeJSON(tool string, pts ...Point) string {
	b, _ := json.Marshal(encode(pts...))
	return fmt.Sprintf(`{"id":"s","tool":%q,"color":"ink","width":4,"points":%s}`, tool, b)
}

func TestParseAndDecode(t *testing.T) {
	data := groupJSON(`{"before":"ab","after":"cd","offset":2,"free":true}`,
		strokeJSON("pen", Point{1, 2, 0.5}, Point{3.5, 4, 0.7}),
		strokeJSON("eraser", Point{0, 0, 0}),
		`{"id":"x","tool":"pen","width":4,"points":[1,2]}`)
	g, err := Parse("g1", data)
	if err != nil {
		t.Fatal(err)
	}
	if !g.Anchor.Free || g.Anchor.Before != "ab" || len(g.Strokes) != 1 {
		t.Fatalf("group = %+v", g)
	}
	if p := g.Strokes[0].Points[1]; p.X != 3.5 || p.Y != 4 || p.P != 0.7 {
		t.Errorf("decoded point = %+v", p)
	}
	if _, err := Parse("g2", json.RawMessage(`{"v":2,"anchor":{},"strokes":[]}`)); err == nil {
		t.Error("v2 payload should be unsupported")
	}
}

func TestRenderDrawsPenOnly(t *testing.T) {
	pen, _ := Parse("p", groupJSON(`{"before":"","after":"","offset":0}`, strokeJSON("pen", Point{0, 0, 0.5}, Point{40, 0, 0.5})))
	r, ok := Render(pen)
	if !ok {
		t.Fatal("nothing rendered")
	}
	img, err := png.Decode(bytes.NewReader(r.PNG))
	if err != nil {
		t.Fatal(err)
	}
	if img.Bounds().Dx() != r.W || r.W < 80 {
		t.Errorf("width = %d (rendering %d)", img.Bounds().Dx(), r.W)
	}
	// The middle of the stroke is dark; a corner is white.
	mid := img.At(int((20-r.Box.X)*r.Scale), int((0-r.Box.Y)*r.Scale))
	if g, _, _, _ := mid.RGBA(); g > 0x4000 {
		t.Errorf("stroke pixel too light: %x", g)
	}
	if g, _, _, _ := img.At(0, 0).RGBA(); g != 0xffff {
		t.Errorf("corner not white: %x", g)
	}

	hi, _ := Parse("h", groupJSON(`{"before":"","after":"","offset":0}`, strokeJSON("highlighter", Point{0, 0, 0.5}, Point{40, 0, 0.5})))
	if hi.Writing() {
		t.Error("highlighter-only group reported as writing")
	}
	if _, ok := Render(hi); ok {
		t.Error("highlighter-only group should not render")
	}
}

func TestResolveAnchor(t *testing.T) {
	md := "# Plan\n\nBuy **milk** and eggs today.\nCall mom."
	cases := []struct {
		a     Anchor
		want  int
		match Match
	}{
		{Anchor{Before: "Call ", After: "mom.", Offset: 40}, strings.Index(md, "mom."), MatchExact},
		// The editor's plain text has no "**": the full context misses, a side window hits.
		{Anchor{Before: "Buy milk and ", After: "eggs today.", Offset: 13}, strings.Index(md, "eggs"), MatchPartial},
		{Anchor{Before: "nothing like", After: "this at all", Offset: 3}, 3, MatchLost},
	}
	for _, c := range cases {
		got, m := ResolveAnchor(md, c.a)
		if got != c.want || m != c.match {
			t.Errorf("ResolveAnchor(%+v) = %d %s, want %d %s", c.a, got, m, c.want, c.match)
		}
	}
}

func TestInsertText(t *testing.T) {
	md := "Buy milk and eggs.\nCall mom.\n"
	out, wheres := InsertText(md, []Placement{
		{Anchor: Anchor{Before: "Buy milk", After: " and eggs.", Offset: 8}, Text: "oat"},
		{Anchor: Anchor{Before: "Call mom.", After: "", Offset: 28, Free: true}, Text: "re: birthday"},
		{Anchor: Anchor{Page: true}, Text: "page text"},
	})
	want := "Buy milk oat and eggs.\nCall mom.\n\nre: birthday\n\npage text\n"
	if out != want {
		t.Errorf("got %q\nwant %q", out, want)
	}
	if wheres[0] != Inline || wheres[1] != Paragraph || wheres[2] != End {
		t.Errorf("wheres = %v", wheres)
	}

	// An empty note takes the text as its body.
	if out, _ := InsertText("", []Placement{{Anchor: Anchor{}, Text: " hello "}}); out != "hello" {
		t.Errorf("empty note = %q", out)
	}
	// A free paragraph between lines keeps both lines as their own blocks.
	out, _ = InsertText("one\ntwo", []Placement{{Anchor: Anchor{Before: "one", After: "\ntwo", Free: true}, Text: "mid"}})
	if out != "one\n\nmid\n\ntwo" {
		t.Errorf("between lines = %q", out)
	}
}

func TestAssignMergesLinesSharingGroups(t *testing.T) {
	a, _ := Parse("a", groupJSON(`{"before":"","after":"","offset":0,"page":true}`, strokeJSON("pen", Point{10, 10, 0.5}, Point{60, 12, 0.5})))
	b, _ := Parse("b", groupJSON(`{"before":"","after":"","offset":0,"page":true}`, strokeJSON("pen", Point{70, 10, 0.5}, Point{120, 12, 0.5})))
	c, _ := Parse("c", groupJSON(`{"before":"","after":"","offset":0,"page":true}`, strokeJSON("pen", Point{10, 200, 0.5}, Point{60, 200, 0.5})))
	d, _ := Parse("d", groupJSON(`{"before":"","after":"","offset":0,"page":true}`, strokeJSON("pen", Point{10, 400, 0.5}, Point{60, 400, 0.5})))
	groups := []*Group{a, b, c, d}
	r, _ := Render(groups...)
	norm := func(x, y, w, h float64) Box {
		return Box{(x - r.Box.X) / r.Box.W, (y - r.Box.Y) / r.Box.H, w / r.Box.W, h / r.Box.H}
	}
	lines := []Line{
		{Text: "second", Confidence: 0.8, Box: norm(5, 190, 60, 20)},
		{Text: "hello world", Confidence: 0.9, Box: norm(5, 2, 120, 16)},
	}
	got, unread := Assign(groups, r, lines)
	if len(got) != 2 || got[0].Text != "hello world" || strings.Join(got[0].GroupIDs, ",") != "a,b" || got[1].Text != "second" {
		t.Fatalf("transcripts = %+v", got)
	}
	if len(unread) != 1 || unread[0] != "d" {
		t.Errorf("unread = %v", unread)
	}
}
