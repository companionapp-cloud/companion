package ink

import (
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// The editor's anchor search (packages/editor/src/ink/anchor.ts), run on a note's markdown.
// The editor matches against the document's plain text, so markup between the anchor's words
// ("**", "[[…]]", list markers) can hide the full context; the shorter windows still find the
// point, and an anchor that isn't found at all is reported as lost.

// Match is how an anchor was found: as written, approximately, or not at all.
type Match string

const (
	MatchExact   Match = "exact"
	MatchPartial Match = "partial"
	MatchLost    Match = "lost"
)

// ResolveAnchor finds an anchor's point in text, returning a byte offset.
func ResolveAnchor(text string, a Anchor) (int, Match) {
	hint := byteOffset(text, a.Offset)
	if a.Before == "" && a.After == "" {
		if text == "" {
			return 0, MatchExact
		}
		return hint, MatchPartial
	}
	if hits := occurrences(text, a.Before+a.After); len(hits) > 0 {
		return nearest(hits, hint) + len(a.Before), MatchExact
	}
	type try struct {
		needle string
		shift  int
	}
	var tries []try
	before, after := []rune(a.Before), []rune(a.After)
	if len(after) >= 4 {
		tries = append(tries, try{a.After, 0})
	}
	if len(before) >= 4 {
		tries = append(tries, try{a.Before, len(a.Before)})
	}
	for _, k := range []int{12, 6} {
		b := string(before[max(0, len(before)-k):])
		af := string(after[:min(k, len(after))])
		if utf8.RuneCountInString(b)+utf8.RuneCountInString(af) >= 6 {
			tries = append(tries, try{b + af, len(b)})
		}
		if utf8.RuneCountInString(af) >= 4 {
			tries = append(tries, try{af, 0})
		}
		if utf8.RuneCountInString(b) >= 4 {
			tries = append(tries, try{b, len(b)})
		}
	}
	for _, t := range tries {
		hits := occurrences(text, t.needle)
		if len(hits) == 0 {
			continue
		}
		for i := range hits {
			hits[i] += t.shift
		}
		return nearest(hits, hint), MatchPartial
	}
	return hint, MatchLost
}

// byteOffset maps a character offset (the editor counts UTF-16 units; runes are close enough
// for a hint) to a byte offset in text.
func byteOffset(text string, chars int) int {
	if chars <= 0 {
		return 0
	}
	n := 0
	for i := range text {
		if n == chars {
			return i
		}
		n++
	}
	return len(text)
}

func occurrences(hay, needle string) []int {
	var out []int
	if needle == "" {
		return out
	}
	for i := 0; ; {
		j := strings.Index(hay[i:], needle)
		if j < 0 {
			return out
		}
		out = append(out, i+j)
		i += j + 1
		if i > len(hay) {
			return out
		}
	}
}

func nearest(candidates []int, hint int) int {
	best := candidates[0]
	for _, c := range candidates {
		if abs(c-hint) < abs(best-hint) {
			best = c
		}
	}
	return best
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// Placement is recognized text that replaces one or more groups. It goes where the first
// group is pinned.
type Placement struct {
	Anchor Anchor
	Text   string
}

// Where says how a placement lands in the text.
type Where string

const (
	// Inline: written over words, the text goes in at that point in the line.
	Inline Where = "inline"
	// Paragraph: written beside a line (free ink) or several lines long, it becomes a paragraph
	// after that line.
	Paragraph Where = "paragraph"
	// End: page ink, ink on an empty note, or ink whose words are gone is appended.
	End Where = "end"
)

type edit struct {
	pos   int
	where Where
	text  string
	seq   int
}

// InsertText places each placement's text in a markdown document and returns the result along
// with where each one went.
func InsertText(md string, items []Placement) (string, []Where) {
	wheres := make([]Where, len(items))
	var edits []edit
	var tail []string
	for i, it := range items {
		text := strings.TrimSpace(it.Text)
		if text == "" {
			continue
		}
		a := it.Anchor
		pos, match := 0, MatchLost
		if !a.Page && (a.Before != "" || a.After != "") {
			pos, match = ResolveAnchor(md, a)
		}
		switch {
		case a.Page || match == MatchLost || (a.Before == "" && a.After == ""):
			wheres[i] = End
			tail = append(tail, text)
		case a.Free || strings.Contains(text, "\n"):
			wheres[i] = Paragraph
			edits = append(edits, edit{lineEnd(md, pos), Paragraph, text, i})
		default:
			wheres[i] = Inline
			edits = append(edits, edit{pos, Inline, text, i})
		}
	}
	// Apply from the end of the document back, so earlier offsets stay valid. At one position,
	// the later placement goes in first so the earlier ends up before it.
	sort.SliceStable(edits, func(i, j int) bool {
		if edits[i].pos != edits[j].pos {
			return edits[i].pos > edits[j].pos
		}
		return edits[i].seq > edits[j].seq
	})
	for _, e := range edits {
		if e.where == Inline {
			md = insertInline(md, e.pos, e.text)
		} else {
			md = insertParagraph(md, e.pos, e.text)
		}
	}
	for _, t := range tail {
		md = insertParagraph(md, len(md), t)
	}
	return md, wheres
}

// lineEnd is the end of the line holding pos.
func lineEnd(md string, pos int) int {
	if i := strings.IndexByte(md[pos:], '\n'); i >= 0 {
		return pos + i
	}
	return len(md)
}

func insertInline(md string, pos int, text string) string {
	prev, _ := utf8.DecodeLastRuneInString(md[:pos])
	next, _ := utf8.DecodeRuneInString(md[pos:])
	if pos > 0 && !unicode.IsSpace(prev) {
		text = " " + text
	}
	if pos < len(md) && !unicode.IsSpace(next) && !unicode.IsPunct(next) {
		text += " "
	}
	return md[:pos] + text + md[pos:]
}

// insertParagraph puts text in its own block at a line end, separated by blank lines.
func insertParagraph(md string, pos int, text string) string {
	head := strings.TrimRight(md[:pos], " \t\n")
	rest := strings.TrimLeft(md[pos:], "\n")
	out := text
	if head != "" {
		out = head + "\n\n" + text
	}
	if rest != "" {
		return out + "\n\n" + rest
	}
	if strings.HasSuffix(md, "\n") {
		out += "\n"
	}
	return out
}
