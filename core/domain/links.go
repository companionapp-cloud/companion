package domain

import "regexp"

// The object graph (PLAN §4.0, §5). Notes, tasks, habits (and later projects) are
// nodes; wikilinks and embeds parsed out of markdown are DERIVED edges. Parsing lives
// here as pure logic so the store (local writes) and the sync-apply path extract links
// identically, and so the server could reuse it if it ever needed to.

// Link node types. Kept permissive at parse time: the parser records whatever type
// token it sees from this set; resolution against real rows happens later (dangling
// targets are expected — PLAN §5.1).
const (
	NodeNote    = "note"
	NodeTask    = "task"
	NodeHabit   = "habit"
	NodeProject = "project"
)

// Edge kinds derived from content. Authored kinds ("stack", "member") are mirrored in
// by the store from their own tables and are not produced here.
const (
	KindRef   = "ref"   // [[type:id]]
	KindEmbed = "embed" // ![[type:id]]
)

// Ref is a single outgoing reference parsed from a source's markdown: the target it
// points at and how (plain reference vs embed).
type Ref struct {
	TargetType string
	TargetID   string
	Kind       string
}

// GraphNode is the slim projection the graph view renders — never entity bodies
// (PLAN §5.2). Status carries a type-specific hint (task status today; habit polarity
// once it exists). ObjectTypeID is reserved for archetypes (milestone: Objects).
type GraphNode struct {
	ID           string  `json:"id"`
	Type         string  `json:"type"`
	Title        string  `json:"title"`
	ObjectTypeID *string `json:"objectTypeId,omitempty"`
	Status       *string `json:"status,omitempty"`
}

// GraphEdge is one row of the derived link index.
type GraphEdge struct {
	SourceType string `json:"sourceType"`
	SourceID   string `json:"sourceId"`
	TargetType string `json:"targetType"`
	TargetID   string `json:"targetId"`
	Kind       string `json:"kind"`
}

// Graph is the payload of graph.full / graph.neighborhood: nodes plus the edges among
// them. Edges may reference targets absent from Nodes (dangling) — the UI renders
// those as ghosts.
type Graph struct {
	Nodes []GraphNode `json:"nodes"`
	Edges []GraphEdge `json:"edges"`
}

// wikilinkRe matches [[type:id]] and ![[type:id]] with an optional |display alias.
// Group 1 is the optional embed bang; group 2 the type token; group 3 the raw target
// id (anything up to a '|' or the closing brackets).
var wikilinkRe = regexp.MustCompile(`(!?)\[\[\s*([a-zA-Z]+)\s*:\s*([^\]|]+?)\s*(?:\|[^\]]*)?\]\]`)

var linkTypes = map[string]bool{
	NodeNote:    true,
	NodeTask:    true,
	NodeHabit:   true,
	NodeProject: true,
}

// ParseRefs extracts the outgoing references from a markdown body. Unknown type tokens
// are ignored; duplicate (type, id, kind) triples are collapsed. Order is preserved by
// first appearance so extraction is deterministic (used by the apply==rebuild test).
func ParseRefs(markdown string) []Ref {
	matches := wikilinkRe.FindAllStringSubmatch(markdown, -1)
	if len(matches) == 0 {
		return nil
	}
	seen := make(map[Ref]bool, len(matches))
	out := make([]Ref, 0, len(matches))
	for _, m := range matches {
		typ := m[2]
		if !linkTypes[typ] {
			continue
		}
		id := m[3]
		if id == "" {
			continue
		}
		kind := KindRef
		if m[1] == "!" {
			kind = KindEmbed
		}
		r := Ref{TargetType: typ, TargetID: id, Kind: kind}
		if seen[r] {
			continue
		}
		seen[r] = true
		out = append(out, r)
	}
	return out
}
