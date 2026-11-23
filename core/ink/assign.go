package ink

import (
	"sort"
	"strings"
)

// Transcript is recognized text and the groups it was read from, ready to hand to a convert
// call.
type Transcript struct {
	GroupIDs   []string `json:"groupIds"`
	Text       string   `json:"text"`
	Confidence float64  `json:"confidence"`
	// Box is where the text sits, in the groups' coordinates (CSS px).
	Box Box `json:"box"`
}

// Assign maps the lines an OCR engine read in one rendering back to the groups that were drawn
// in it. Lines that touch a common group merge into one transcript, so a word written as two
// groups comes back as one piece of text. Transcripts are in reading order (top to bottom).
// Groups that no line touched are returned as unread.
func Assign(groups []*Group, r *Rendering, lines []Line) (out []Transcript, unread []string) {
	type gbox struct {
		id  string
		box Box
	}
	var boxes []gbox
	for _, g := range groups {
		if b, ok := Bounds(g); ok {
			boxes = append(boxes, gbox{g.ID, b})
		}
	}
	// Union-find over lines: two lines join when they share a group.
	parent := make([]int, len(lines))
	for i := range parent {
		parent[i] = i
	}
	var find func(int) int
	find = func(i int) int {
		if parent[i] != i {
			parent[i] = find(parent[i])
		}
		return parent[i]
	}
	owner := map[string]int{} // group id → first line that touched it
	lineBox := make([]Box, len(lines))
	for i, l := range lines {
		lb := Box{r.Box.X + l.Box.X*r.Box.W, r.Box.Y + l.Box.Y*r.Box.H, l.Box.W * r.Box.W, l.Box.H * r.Box.H}
		lineBox[i] = lb
		for _, gb := range boxes {
			if !gb.box.Intersects(lb) {
				continue
			}
			if j, ok := owner[gb.id]; ok {
				parent[find(i)] = find(j)
			} else {
				owner[gb.id] = i
			}
		}
	}
	type cluster struct {
		lines []int
		ids   []string
	}
	clusters := map[int]*cluster{}
	var roots []int
	for i := range lines {
		root := find(i)
		c, ok := clusters[root]
		if !ok {
			c = &cluster{}
			clusters[root] = c
			roots = append(roots, root)
		}
		c.lines = append(c.lines, i)
	}
	for _, gb := range boxes {
		if i, ok := owner[gb.id]; ok {
			c := clusters[find(i)]
			c.ids = append(c.ids, gb.id)
		} else {
			unread = append(unread, gb.id)
		}
	}
	for _, root := range roots {
		c := clusters[root]
		if len(c.ids) == 0 {
			continue // a line over no ink (noise)
		}
		sort.SliceStable(c.lines, func(a, b int) bool { return lineBox[c.lines[a]].Y < lineBox[c.lines[b]].Y })
		var texts []string
		var box Box
		conf := 0.0
		for k, i := range c.lines {
			if t := strings.TrimSpace(lines[i].Text); t != "" {
				texts = append(texts, t)
			}
			conf += lines[i].Confidence
			if k == 0 {
				box = lineBox[i]
			} else {
				box = box.union(lineBox[i])
			}
		}
		if len(texts) == 0 {
			unread = append(unread, c.ids...)
			continue
		}
		out = append(out, Transcript{GroupIDs: c.ids, Text: strings.Join(texts, "\n"), Confidence: conf / float64(len(c.lines)), Box: box})
	}
	sort.SliceStable(out, func(a, b int) bool { return out[a].Box.Y < out[b].Box.Y })
	return out, unread
}
