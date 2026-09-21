package export

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Reading exported files back: the inverse of render.go, used by the one-time file import and by
// Git sync. A markdown file is front matter plus a body; what kind of item it is, and which one,
// comes from its `kind` and `id` — or, for a file from somewhere else (an Obsidian vault, a
// folder of notes), from where it sits and what it's called.
//
// Parsing is forgiving by design — these are files people edit by hand. A file with no front
// matter is a note whose title is its filename; an unknown key is ignored; a value that doesn't
// parse is dropped rather than failing the file. What comes out is a patch: only the fields the
// file actually carries, so applying it never blanks something the file had no way to express.

// Value is one front-matter value as written: a scalar's text, or a list's.
type Value struct {
	Scalar string
	List   []string
	IsList bool
}

// Document is a parsed markdown file.
type Document struct {
	// Meta is the front matter by key; nil when the file has none.
	Meta map[string]Value
	Body string
}

var errFrontMatter = errors.New("front matter isn't valid YAML")

// maxFrontMatter bounds the YAML handed to the parser: files arrive from outside (a shared Git
// repository), and front matter is a handful of lines.
const maxFrontMatter = 64 << 10

// ParseMarkdown splits a file into front matter and body. CRLF line endings and a UTF-8 byte
// order mark are normalised away.
func ParseMarkdown(content []byte) (Document, error) {
	text := strings.ReplaceAll(string(bytes.TrimPrefix(content, []byte("\xef\xbb\xbf"))), "\r\n", "\n")
	if !strings.HasPrefix(text, "---\n") {
		return Document{Body: strings.TrimSpace(text)}, nil
	}
	end := strings.Index(text[4:], "\n---")
	if end < 0 {
		return Document{Body: strings.TrimSpace(text)}, nil
	}
	block, rest := text[4:4+end+1], text[4+end+4:]
	// The closing fence is its own line.
	if rest != "" && !strings.HasPrefix(rest, "\n") {
		return Document{Body: strings.TrimSpace(text)}, nil
	}
	if len(block) > maxFrontMatter {
		return Document{}, fmt.Errorf("%w: too long", errFrontMatter)
	}
	var root yaml.Node
	if err := yaml.Unmarshal([]byte(block), &root); err != nil {
		return Document{}, fmt.Errorf("%w: %v", errFrontMatter, err)
	}
	doc := Document{Meta: map[string]Value{}, Body: strings.TrimSpace(rest)}
	if len(root.Content) == 0 {
		return doc, nil
	}
	mapping := root.Content[0]
	if mapping.Kind != yaml.MappingNode {
		return Document{}, fmt.Errorf("%w: expected keys and values", errFrontMatter)
	}
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		key, val := mapping.Content[i], mapping.Content[i+1]
		if val.Kind == yaml.AliasNode { // anchors and aliases are how YAML bombs are built
			continue
		}
		switch val.Kind {
		case yaml.ScalarNode:
			if val.Tag == "!!null" {
				doc.Meta[key.Value] = Value{}
			} else {
				doc.Meta[key.Value] = Value{Scalar: val.Value}
			}
		case yaml.SequenceNode:
			v := Value{IsList: true}
			for _, item := range val.Content {
				if item.Kind == yaml.ScalarNode {
					v.List = append(v.List, item.Value)
				}
			}
			doc.Meta[key.Value] = v
		}
	}
	return doc, nil
}

// Has reports whether the front matter carries the key at all — the difference between "the
// file says this is empty" and "the file doesn't say".
func (d Document) Has(key string) bool { _, ok := d.Meta[key]; return ok }

func (d Document) Get(key string) string { return strings.TrimSpace(d.Meta[key].Scalar) }

// Strings is a key's values whether it was written as a list or as one scalar.
func (d Document) Strings(key string) []string {
	v := d.Meta[key]
	if v.IsList {
		return v.List
	}
	if s := strings.TrimSpace(v.Scalar); s != "" {
		return []string{s}
	}
	return nil
}

// ParseWhen reads a front-matter date: a plain date is that day's midnight in loc (the app's
// convention for "a date with no time"), anything longer an instant.
func ParseWhen(s string, loc *time.Location) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if loc == nil {
		loc = time.Local
	}
	if t, err := time.ParseInLocation("2006-01-02", s, loc); err == nil {
		return t, true
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05", "2006-01-02T15:04", "2006-01-02 15:04:05", "2006-01-02 15:04"} {
		if t, err := time.ParseInLocation(layout, s, loc); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// ---- where a file sits ------------------------------------------------------------------

// Place is what a path says about a file: what kind of thing it holds and where it's filed.
type Place struct {
	// Kind is "note", "task" or "canvas"; "" when the path doesn't say (a markdown file in a
	// folder of someone's own — the front matter, or a default, decides).
	Kind string
	// Area and Project are the names of the folders it's filed under in the export layout;
	// empty at the root, or outside that layout.
	Area    string
	Project string
	// Stem is the filename without its extension — the title of a file that doesn't give one.
	Stem string
}

// PlaceOf reads a slash-separated path against the layout render.go writes:
// [Areas/<area>/[<project>/]]{Notes|Tasks|Canvases}/<title>.{md|json}.
func PlaceOf(path string) Place {
	segments := strings.Split(path, "/")
	file := segments[len(segments)-1]
	p := Place{Stem: strings.TrimSuffix(file, pathExt(file))}
	dirs := segments[:len(segments)-1]
	if len(dirs) == 0 {
		return p
	}
	switch dirs[len(dirs)-1] {
	case dirNotes:
		p.Kind = KindNote
	case dirTasks:
		p.Kind = KindTask
	case dirCanvases:
		p.Kind = "canvas"
	case dirAttachments:
		p.Kind = KindDocument
		p.Stem = file // an attachment's name is its whole filename
		return p
	default:
		return p
	}
	dirs = dirs[:len(dirs)-1]
	if len(dirs) >= 2 && dirs[0] == dirAreas {
		p.Area = dirs[1]
		if len(dirs) >= 3 {
			p.Project = dirs[2]
		}
	}
	return p
}

// Owned reports whether a path is one this exporter writes: a .md or .json file under one of
// its top-level folders, or anything in Attachments. Git sync reads and deletes only these; a README, a .gitignore or a
// workflow file in the same repository is none of its business.
func Owned(path string) bool {
	top, _, nested := strings.Cut(path, "/")
	if !nested {
		return false
	}
	switch top {
	case dirAttachments:
		return !strings.HasPrefix(path[strings.LastIndex(path, "/")+1:], ".") // any file but a dotfile
	case dirAreas, dirNotes, dirTasks, dirCanvases:
	default:
		return false
	}
	ext := pathExt(path)
	return ext == ".md" || ext == ".json"
}

// IsAttachmentPath reports whether an owned path holds an attachment rather than an item.
func IsAttachmentPath(path string) bool { return strings.HasPrefix(path, dirAttachments+"/") }

// ---- links ------------------------------------------------------------------------------

// plainLink is a wikilink as it reads outside the app: `[[Target]]`, `[[Target|alias]]`,
// `![[file.png]]`. (An app link, `[[note:<id>]]`, has a lowercase type and a colon first, and is
// left alone.)
var plainLink = regexp.MustCompile(`(!?)\[\[([^\]|\n]+?)(?:\|([^\]\n]*))?\]\]`)

var appLink = regexp.MustCompile(`^[a-z]+:[^\s]+$`)

// LinkTarget is something a wikilink can point at.
type LinkTarget struct {
	Type string // the app's link type: note, task, project, canvas, doc
	ID   string
}

// Resolver turns portable links back into the app's own. It knows every linkable thing by
// title and — for what was exported — by path.
type Resolver struct {
	byTitle map[string][]LinkTarget
	byPath  map[string]LinkTarget
	byFile  map[string]LinkTarget   // attachments, by their whole path — extension and all
	byName  map[string][]LinkTarget // …and by bare filename, the way Obsidian finds them
}

func NewResolver() *Resolver {
	return &Resolver{byTitle: map[string][]LinkTarget{}, byPath: map[string]LinkTarget{}, byFile: map[string]LinkTarget{}, byName: map[string][]LinkTarget{}}
}

// AddFile registers an attachment's file. Unlike AddPath the extension counts: photo.png and
// photo.jpg are different files.
func (r *Resolver) AddFile(path string, t LinkTarget) {
	r.byFile[strings.ToLower(path)] = t
	name := strings.ToLower(path[strings.LastIndex(path, "/")+1:])
	r.byName[name] = append(r.byName[name], t)
}

// file finds the attachment a link or an image names: by its path from the root, by its path
// from the folder of the file that mentions it, or by a bare filename that is unique.
func (r *Resolver) file(target, fromDir string) (LinkTarget, bool) {
	target = strings.TrimPrefix(strings.ReplaceAll(target, "%20", " "), "./")
	if t, ok := r.byFile[strings.ToLower(target)]; ok {
		return t, true
	}
	if fromDir != "" {
		if t, ok := r.byFile[strings.ToLower(cleanJoin(fromDir, target))]; ok {
			return t, true
		}
	}
	if named := r.byName[strings.ToLower(target[strings.LastIndex(target, "/")+1:])]; len(named) == 1 {
		return named[0], true
	}
	return LinkTarget{}, false
}

// cleanJoin resolves a relative path against a folder, without leaving the root.
func cleanJoin(dir, rel string) string {
	parts := strings.Split(dir, "/")
	for _, seg := range strings.Split(rel, "/") {
		switch seg {
		case "", ".":
		case "..":
			if len(parts) > 0 {
				parts = parts[:len(parts)-1]
			}
		default:
			parts = append(parts, seg)
		}
	}
	return strings.Join(parts, "/")
}

// markdownImage is a standard markdown image or link to a local file: ![alt](path).
var markdownImage = regexp.MustCompile(`!\[([^\]\n]*)\]\(([^)\s]+)\)`)

func (r *Resolver) AddTitle(title string, t LinkTarget) {
	key := strings.ToLower(strings.TrimSpace(title))
	if key == "" {
		return
	}
	for _, existing := range r.byTitle[key] {
		if existing == t {
			return
		}
	}
	r.byTitle[key] = append(r.byTitle[key], t)
}

// AddPath registers a file's path (with or without its extension) as naming a target.
func (r *Resolver) AddPath(path string, t LinkTarget) {
	r.byPath[strings.ToLower(strings.TrimSuffix(path, pathExt(path)))] = t
}

// File is the attachment at a path.
func (r *Resolver) File(path string) (LinkTarget, bool) { return r.file(path, "") }

// ByPath is the target an exported file stands for.
func (r *Resolver) ByPath(path string) (LinkTarget, bool) {
	t, ok := r.byPath[strings.ToLower(strings.TrimSuffix(path, pathExt(path)))]
	return t, ok
}

// Resolve rewrites `[[Title]]` to `[[note:<id>|…]]` wherever the title — or path — names exactly
// one thing. A link that names nothing, or several things, is left as it is: the editor shows
// it as an unresolved link, which is what it is.
func (r *Resolver) Resolve(md string) string { return r.ResolveFrom(md, "") }

// ResolveFrom is Resolve for a file in a given folder, which relative attachment paths —
// `![](../images/x.png)`, as plain markdown writes an image — are read against.
func (r *Resolver) ResolveFrom(md, fromDir string) string {
	md = markdownImage.ReplaceAllStringFunc(md, func(whole string) string {
		m := markdownImage.FindStringSubmatch(whole)
		if strings.Contains(m[2], "://") {
			return whole // an image on the web stays one
		}
		t, ok := r.file(m[2], fromDir)
		if !ok {
			return whole
		}
		return "![[" + t.Type + ":" + t.ID + "]]"
	})
	return plainLink.ReplaceAllStringFunc(md, func(whole string) string {
		m := plainLink.FindStringSubmatch(whole)
		target, alias := strings.TrimSpace(m[2]), m[3]
		if appLink.MatchString(target) {
			return whole
		}
		if t, ok := r.file(target, fromDir); ok && (m[1] == "!" || strings.Contains(target, ".")) {
			if alias != "" {
				return m[1] + "[[" + t.Type + ":" + t.ID + "|" + alias + "]]"
			}
			return m[1] + "[[" + t.Type + ":" + t.ID + "]]"
		}
		t, ok := r.byPath[strings.ToLower(strings.TrimSuffix(target, ".md"))]
		if !ok {
			candidates := r.byTitle[strings.ToLower(target)]
			if len(candidates) != 1 {
				return whole
			}
			t = candidates[0]
		}
		// An alias that only repeated the title (how an ambiguous link is written) isn't one.
		if alias != "" && strings.Contains(target, "/") {
			if titled := r.byTitle[strings.ToLower(alias)]; len(titled) > 0 {
				for _, c := range titled {
					if c == t {
						alias = ""
					}
				}
			}
		}
		if alias != "" {
			return m[1] + "[[" + t.Type + ":" + t.ID + "|" + alias + "]]"
		}
		return m[1] + "[[" + t.Type + ":" + t.ID + "]]"
	})
}

// ---- canvases ---------------------------------------------------------------------------

// ParsedCanvas is a board read back from its JSON.
type ParsedCanvas struct {
	ID    string
	Name  string
	Nodes []ParsedCanvasNode
	Edges []ParsedCanvasEdge
}

type ParsedCanvasNode struct {
	ID                  string
	Kind                string
	X, Y, Width, Height float64
	Z                   int
	Color               string
	RefType, RefID      string
	Data                json.RawMessage
	// File is the exported file a `file` node points at — how an embedded note or task is found
	// again in a workspace where its id means nothing.
	File string
}

type ParsedCanvasEdge struct {
	ID, From, To     string
	FromSide, ToSide string
	FromEnd, ToEnd   string
	Style            string
	Label, Color     string
}

// ParseCanvas reads a board. Its own `companion` blocks are authoritative where present; without
// them (a canvas drawn in another tool) the JSON Canvas fields are mapped onto the app's kinds:
// text, group and link carry over, and a `file` node — which points at something this reader
// can't identify — becomes a text card naming the file.
func ParseCanvas(content []byte) (ParsedCanvas, error) {
	var in jsonCanvas
	if err := json.Unmarshal(content, &in); err != nil {
		return ParsedCanvas{}, fmt.Errorf("canvas isn't valid JSON: %w", err)
	}
	var out ParsedCanvas
	if in.Companion != nil {
		out.ID, out.Name = in.Companion.ID, in.Companion.Name
	}
	for _, n := range in.Nodes {
		node := ParsedCanvasNode{ID: n.ID, X: float64(n.X), Y: float64(n.Y), Width: float64(n.Width), Height: float64(n.Height), Color: n.Color}
		if c := n.Companion; c != nil {
			node.Kind, node.RefType, node.RefID, node.Z, node.Data = c.Kind, c.RefType, c.RefID, c.Z, c.Data
		}
		// The visible fields win over the block for what both can say, so an edit made in
		// another tool — new sticky text, a renamed group — comes through.
		node.File = n.File
		payload := func(key, value string) json.RawMessage {
			var data map[string]any
			_ = json.Unmarshal(node.Data, &data)
			if data == nil {
				data = map[string]any{}
			}
			// Untouched, the payload stays byte for byte what it was — re-encoding would only
			// reorder its keys and make an unchanged board look edited.
			if current, _ := data[key].(string); current == value && len(node.Data) > 0 {
				return node.Data
			}
			data[key] = value
			raw, _ := json.Marshal(data)
			return raw
		}
		switch n.Type {
		case "text":
			if node.Kind == "" || node.Kind == "text" {
				node.Kind, node.Data = "text", payload("text", n.Text)
			}
		case "group":
			node.Kind, node.Data = "group", payload("label", n.Label)
		case "link":
			node.Kind, node.Data = "link", payload("url", n.URL)
		case "file":
			if node.Kind == "" {
				node.Kind, node.Data = "text", payload("text", n.File)
			}
		}
		if node.Kind == "" || node.ID == "" {
			continue
		}
		out.Nodes = append(out.Nodes, node)
	}
	for _, e := range in.Edges {
		if e.ID == "" || e.FromNode == "" || e.ToNode == "" {
			continue
		}
		edge := ParsedCanvasEdge{ID: e.ID, From: e.FromNode, To: e.ToNode, FromSide: e.FromSide, ToSide: e.ToSide, Label: e.Label, Color: e.Color, FromEnd: e.FromEnd, ToEnd: e.ToEnd}
		if c := e.Companion; c != nil {
			edge.Style = c.Style
			// Keep the app's finer ending unless the coarse one was changed under it.
			if c.FromEnd != "" && canvasEnd(c.FromEnd) == orNone(e.FromEnd) {
				edge.FromEnd = c.FromEnd
			}
			if c.ToEnd != "" && canvasEnd(c.ToEnd) == orArrow(e.ToEnd) {
				edge.ToEnd = c.ToEnd
			}
		}
		out.Edges = append(out.Edges, edge)
	}
	return out, nil
}

// JSON Canvas's defaults: no ending at the start of an edge, an arrow at its end.
func orNone(end string) string {
	if end == "" {
		return "none"
	}
	return end
}

func orArrow(end string) string {
	if end == "" {
		return "arrow"
	}
	return end
}
