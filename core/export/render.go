// Package export mirrors the workspace out of the database as plain files — notes and tasks as
// markdown with YAML front matter, canvases as JSON Canvas — for the scheduled filesystem and
// Git exports. It is one-way: nothing here reads the files back.
//
// The shape is render → diff → sink. Render turns the whole workspace into a deterministic set of
// files; Diff compares it with the manifest of what a destination already holds and yields only
// the real changes (so a rename is a delete plus a write, and a rebuild is an empty manifest);
// a sink — a folder (FolderSink) or a bare Git repository (gitsink) — applies them. The two sinks
// are independent: a destination is one or the other, fed the same change set.
package export

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"

	"companion/core/domain"
	"companion/core/store"
)

// File is one rendered file: a slash-separated path relative to the destination's root.
//
// A note, a task or a canvas carries its Content. An attachment doesn't: a document is
// content-addressed, so its hash is known without touching its bytes, and only an attachment that
// actually has to be written is ever loaded (Load) — a workspace's worth of photos is not read
// into memory to find that nothing changed.
type File struct {
	Path       string
	Content    []byte
	EntityType string
	EntityID   string

	// Hash, Size and Load describe an attachment in place of Content.
	Hash string
	Size int64
	Load func() ([]byte, error)
}

// SHA is the content hash the manifest records.
func (f File) SHA() string {
	if f.Hash != "" {
		return f.Hash
	}
	sum := sha256.Sum256(f.Content)
	return hex.EncodeToString(sum[:])
}

// KindDocument is the manifest's entity type for an attachment.
const KindDocument = "document"

// ErrAttachmentUnavailable means an attachment's bytes aren't on this device (and couldn't be
// fetched): a document synced from another device is only metadata until its file is downloaded.
// It is skipped, not failed — it goes out on a later run, once the bytes are here.
var ErrAttachmentUnavailable = errors.New("attachment isn't downloaded yet")

// AttachmentReader reads a document's bytes by their sha256. Nil leaves attachments out.
type AttachmentReader interface {
	Load(sha256 string) ([]byte, error)
}

// The kinds a markdown file can hold, as its front matter's `kind` says.
const (
	KindNote = "note"
	KindTask = "task"
)

// FormatVersion is the layout and front-matter schema written here. Version 2 made the files
// round-trippable — every file names its item (`id`, `kind`), reminders are data, and a canvas
// carries the app's own model beside the JSON Canvas one — so they can be read back (parse.go).
const FormatVersion = 2

// The top-level folders. Filed content sits under Areas/<area>[/<project>]/, the rest at the
// root, each split by kind so a note and a task that share a title never collide.
const (
	dirAreas    = "Areas"
	dirNotes    = "Notes"
	dirTasks    = "Tasks"
	dirCanvases = "Canvases"
	// Files embedded in notes and boards. One flat folder: an attachment isn't filed anywhere
	// itself, and the same file can be embedded from several places.
	dirAttachments = "Attachments"
)

// Render lays the whole workspace out as files. Trashed items are left out. Output is
// deterministic — the same database renders the same paths and bytes — which is what lets Diff
// find only real changes. loc is the zone "a date with no time" is read in (the device's).
func Render(st *store.Store, loc *time.Location, attachments AttachmentReader) ([]File, error) {
	if loc == nil {
		loc = time.Local
	}
	r := &renderer{st: st, loc: loc, blobs: attachments, titles: map[string]string{}, folders: map[string]string{}, filedIn: map[string]string{}, taken: map[string]bool{}, paths: map[string]string{}}
	if err := r.load(); err != nil {
		return nil, err
	}
	r.assignPaths()

	var files []File
	for _, n := range r.notes {
		files = append(files, File{Path: r.paths[n.ID], Content: []byte(r.note(n)), EntityType: "note", EntityID: n.ID})
	}
	for _, t := range r.tasks {
		files = append(files, File{Path: r.paths[t.ID], Content: []byte(r.task(t)), EntityType: "task", EntityID: t.ID})
	}
	for _, c := range r.canvases {
		content, err := r.canvas(c)
		if err != nil {
			return nil, err
		}
		files = append(files, File{Path: r.paths[c.ID], Content: content, EntityType: "canvas", EntityID: c.ID})
	}
	for _, d := range r.docs {
		sha := d.SHA256
		files = append(files, File{Path: r.paths[d.ID], EntityType: KindDocument, EntityID: d.ID, Hash: sha, Size: d.Size,
			Load: func() ([]byte, error) { return r.blobs.Load(sha) }})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files, nil
}

type renderer struct {
	st    *store.Store
	loc   *time.Location
	blobs AttachmentReader
	docs  []*domain.Document

	notes    []*domain.Note
	tasks    []*domain.Task
	canvases []*domain.Canvas
	types    map[string]*domain.ObjectType

	titles  map[string]string // any linkable id → its title (a document's filename)
	folders map[string]string // entity id → the folder it's filed under ("" = root)
	filedIn map[string]string // entity id → its project's or area's name
	taken   map[string]bool   // lower-cased paths already assigned
	paths   map[string]string // entity id → path

	titleCount map[string]int // lower-cased title → how many linkable things bear it
}

func (r *renderer) load() error {
	var err error
	if r.notes, err = r.st.Notes.List(); err != nil {
		return fmt.Errorf("export: list notes: %w", err)
	}
	if r.tasks, err = r.st.Tasks.List(); err != nil {
		return fmt.Errorf("export: list tasks: %w", err)
	}
	// A repeating task's definition (its "seed") isn't a to-do and so isn't in List, but it is
	// the user's data — and the only copy of the rule — so it exports beside the occurrences.
	seeds, err := r.st.Tasks.ListSeeds()
	if err != nil {
		return fmt.Errorf("export: list repeating tasks: %w", err)
	}
	r.tasks = append(r.tasks, seeds...)
	if r.canvases, err = r.st.Canvases.List(); err != nil {
		return fmt.Errorf("export: list canvases: %w", err)
	}
	// Oldest first, so when two items want one filename the older keeps it and a new arrival
	// never renames an existing file.
	sort.SliceStable(r.notes, func(i, j int) bool {
		return older(r.notes[i].CreatedAt, r.notes[i].ID, r.notes[j].CreatedAt, r.notes[j].ID)
	})
	sort.SliceStable(r.tasks, func(i, j int) bool {
		return older(r.tasks[i].CreatedAt, r.tasks[i].ID, r.tasks[j].CreatedAt, r.tasks[j].ID)
	})
	sort.SliceStable(r.canvases, func(i, j int) bool {
		return older(r.canvases[i].CreatedAt, r.canvases[i].ID, r.canvases[j].CreatedAt, r.canvases[j].ID)
	})

	for _, n := range r.notes {
		r.titles[n.ID] = orDefault(n.Title, "Untitled")
	}
	for _, t := range r.tasks {
		r.titles[t.ID] = orDefault(t.Title, "Untitled task")
	}
	for _, c := range r.canvases {
		r.titles[c.ID] = orDefault(c.Name, "Untitled canvas")
	}
	docs, err := r.st.Documents.List()
	if err != nil {
		return fmt.Errorf("export: list documents: %w", err)
	}
	for _, d := range docs {
		r.titles[d.ID] = d.Filename
		if r.blobs != nil && d.SHA256 != "" {
			r.docs = append(r.docs, d)
		}
	}
	sort.SliceStable(r.docs, func(i, j int) bool {
		return older(r.docs[i].CreatedAt, r.docs[i].ID, r.docs[j].CreatedAt, r.docs[j].ID)
	})

	types, err := r.st.ObjectTypes.List()
	if err != nil {
		return fmt.Errorf("export: list object types: %w", err)
	}
	r.types = map[string]*domain.ObjectType{}
	for _, t := range types {
		r.types[t.ID] = t
	}

	areas, err := r.st.Areas.List()
	if err != nil {
		return fmt.Errorf("export: list areas: %w", err)
	}
	areaName := map[string]string{}
	for _, a := range areas {
		areaName[a.ID] = a.Name
		members, err := r.st.ProjectMembers.ListForArea(a.ID)
		if err != nil {
			return fmt.Errorf("export: area members: %w", err)
		}
		for _, m := range members {
			r.folders[m.EntityID] = dirAreas + "/" + Segment(a.Name, "Area")
			r.filedIn[m.EntityID] = a.Name
		}
	}
	projects, err := r.st.Projects.List()
	if err != nil {
		return fmt.Errorf("export: list projects: %w", err)
	}
	for _, p := range projects {
		r.titles[p.ID] = p.Name
		members, err := r.st.ProjectMembers.ListForProject(p.ID)
		if err != nil {
			return fmt.Errorf("export: project members: %w", err)
		}
		for _, m := range members {
			r.folders[m.EntityID] = dirAreas + "/" + Segment(areaName[p.AreaID], "Area") + "/" + Segment(p.Name, "Project")
			r.filedIn[m.EntityID] = p.Name
		}
	}
	return nil
}

func older(a time.Time, aID string, b time.Time, bID string) bool {
	if !a.Equal(b) {
		return a.Before(b)
	}
	return aID < bID
}

func orDefault(s, fallback string) string {
	if strings.TrimSpace(s) == "" {
		return fallback
	}
	return s
}

// assignPaths gives every item its file. Notes and tasks first: a canvas refers to theirs.
func (r *renderer) assignPaths() {
	r.titleCount = map[string]int{}
	for _, title := range r.titles {
		r.titleCount[strings.ToLower(title)]++
	}
	for _, n := range r.notes {
		r.paths[n.ID] = r.claim(r.folders[n.ID], dirNotes, r.titles[n.ID], ".md")
	}
	for _, t := range r.tasks {
		r.paths[t.ID] = r.claim(r.folders[t.ID], dirTasks, r.titles[t.ID], ".md")
	}
	for _, c := range r.canvases {
		r.paths[c.ID] = r.claim(r.folders[c.ID], dirCanvases, r.titles[c.ID], ".json")
	}
	for _, d := range r.docs {
		ext := pathExt(d.Filename)
		r.paths[d.ID] = r.claim("", dirAttachments, strings.TrimSuffix(d.Filename, ext), strings.ToLower(ext))
	}
}

// claim reserves folder/kind/title.ext, stepping aside the way Finder does ("Plan 2") when the
// name is taken — case-insensitively, since the usual filesystems are.
func (r *renderer) claim(folder, kind, title, ext string) string {
	dir := kind
	if folder != "" {
		dir = folder + "/" + kind
	}
	stem := Segment(title, "Untitled")
	for n := 1; ; n++ {
		name := stem
		if n > 1 {
			name = fmt.Sprintf("%s %d", stem, n)
		}
		path := dir + "/" + name + ext
		if key := strings.ToLower(path); !r.taken[key] {
			r.taken[key] = true
			return path
		}
	}
}

// Segment makes a title safe as one path segment on every platform: no separators or characters
// a filesystem refuses, no leading or trailing dots and spaces, a sane length.
func Segment(title, fallback string) string {
	mapped := strings.Map(func(c rune) rune {
		if c < 0x20 || c == 0x7f || strings.ContainsRune(`/\:*?"<>|`, c) {
			return ' '
		}
		return c
	}, title)
	cleaned := strings.Trim(strings.Join(strings.Fields(mapped), " "), ". ")
	if runes := []rune(cleaned); len(runes) > 120 {
		cleaned = strings.TrimRightFunc(string(runes[:120]), func(c rune) bool { return unicode.IsSpace(c) || c == '.' })
	}
	if cleaned == "" {
		return fallback
	}
	return cleaned
}

// ---- markdown ---------------------------------------------------------------------------

// wikilink matches the app's `[[type:id]]` / `![[doc:id|alias]]` syntax (core/domain/links.go).
var wikilink = regexp.MustCompile(`(!?)\[\[([a-z]+):([^\]|]+)(?:\|([^\]]*))?\]\]`)

// portable rewrites app-only link syntax into what reads outside the app: `[[note:<id>]]` becomes
// `[[Title]]` (an alias is kept as `[[Title|alias]]`), `![[doc:<id>]]` becomes `![[filename]]`.
// When several things share the title, the link names its target's file instead —
// `[[Notes/Target 2|Target]]`, the way Obsidian disambiguates — so it still points at one thing
// when it is read back (Resolver). A link whose target is gone is left as written.
func (r *renderer) portable(md string) string {
	return wikilink.ReplaceAllStringFunc(md, func(whole string) string {
		m := wikilink.FindStringSubmatch(whole)
		title, ok := r.titles[m[3]]
		if !ok {
			return whole
		}
		target, alias := title, m[4]
		if path, exported := r.paths[m[3]]; exported && strings.HasPrefix(path, dirAttachments+"/") {
			// An attachment is always named by its file, extension and all: that is what another
			// tool opens, and the one form that survives two files sharing a name.
			target = path
		} else if exported && r.titleCount[strings.ToLower(title)] > 1 {
			target = strings.TrimSuffix(path, pathExt(path))
			if alias == "" {
				alias = title
			}
		}
		if alias != "" && alias != target {
			return m[1] + "[[" + target + "|" + alias + "]]"
		}
		return m[1] + "[[" + target + "]]"
	})
}

func pathExt(path string) string {
	if i := strings.LastIndex(path, "."); i > strings.LastIndex(path, "/") {
		return path[i:]
	}
	return ""
}

func body(md string) string {
	if trimmed := strings.TrimSpace(md); trimmed != "" {
		return trimmed + "\n"
	}
	return ""
}

func (r *renderer) note(n *domain.Note) string {
	fields := []field{{"title", r.titles[n.ID]}}
	if n.Date != nil {
		fields = append(fields, field{"date", *n.Date})
	}
	fields = append(fields,
		field{"created", yamlInstant(n.CreatedAt)},
		field{"updated", yamlInstant(n.UpdatedAt)},
		field{"filed_in", r.filedIn[n.ID]},
		field{"kind", KindNote},
		field{"id", n.ID},
	)
	fields = append(fields, r.archetype(n.ObjectTypeID, n.Props)...)
	return frontMatter(fields) + body(r.portable(n.ContentMD))
}

func (r *renderer) task(t *domain.Task) string {
	start := yamlDate(t.StartAt, r.loc)
	if t.Someday {
		start = "someday"
	}
	var reminders []string
	for _, rem := range t.Reminders {
		// As data, not words: an instant, or the ISO-8601 lead before the deadline ("P1D").
		if rem.At != nil {
			reminders = append(reminders, yamlInstant(*rem.At))
		} else if rem.Before != "" {
			reminders = append(reminders, rem.Before)
		}
	}
	repeat := ""
	if t.RepeatRule != nil {
		repeat = strings.TrimSpace(*t.RepeatRule)
	}
	fields := []field{
		{"title", r.titles[t.ID]},
		{"status", t.Status},
		{"start", start},
		{"deadline", yamlDate(t.DueAt, r.loc)},
		// The rule itself (RFC 5545), not a description of it: this file is a record.
		{"repeat", repeat},
		{"reminders", reminders},
		{"completed", yamlDate(t.CompletedAt, r.loc)},
		{"created", yamlInstant(t.CreatedAt)},
		{"updated", yamlInstant(t.UpdatedAt)},
		{"filed_in", r.filedIn[t.ID]},
		{"kind", KindTask},
		{"id", t.ID},
	}
	fields = append(fields, r.archetype(t.ObjectTypeID, t.Props)...)
	return frontMatter(fields) + body(r.portable(t.NotesMD))
}

// archetype is an object type's name and the item's properties (PLAN §6.3), keyed as the schema
// keys them. A reference reads as its target's title.
func (r *renderer) archetype(typeID *string, props json.RawMessage) []field {
	if typeID == nil {
		return nil
	}
	t := r.types[*typeID]
	if t == nil {
		return nil
	}
	out := []field{{"type", t.Name}}
	schema, err := domain.ParseSchema(t.SchemaJSON)
	if err != nil || len(props) == 0 {
		return out
	}
	var values map[string]any
	if json.Unmarshal(props, &values) != nil {
		return out
	}
	for _, f := range schema.Fields {
		switch v := values[f.Key].(type) {
		case string:
			if f.Type == "reference" {
				if title, ok := r.titles[v]; ok {
					v = title
				}
			}
			out = append(out, field{f.Key, v})
		case bool, float64:
			out = append(out, field{f.Key, v})
		case []any:
			var items []string
			for _, item := range v {
				s := fmt.Sprint(item)
				if title, ok := r.titles[s]; ok && f.Type == "reference" {
					s = title
				}
				items = append(items, s)
			}
			out = append(out, field{f.Key, items})
		}
	}
	return out
}

// ---- canvases ---------------------------------------------------------------------------

// A board exports as a .json file holding JSON Canvas (jsoncanvas.org) — the open format the
// app's own model is compatible with by design (core/domain/canvas.go): nodes and edges any
// tool can read, and that anything speaking JSON Canvas can import. A card that embeds a note or a task becomes a `file` node pointing at that item's
// exported markdown; events and images, which have no file here, become text nodes.
type jsonCanvas struct {
	Nodes []jsonCanvasNode `json:"nodes"`
	Edges []jsonCanvasEdge `json:"edges"`
	// Companion says which board this is. JSON Canvas readers ignore keys they don't know.
	Companion *CanvasMeta `json:"companion,omitempty"`
}

// CanvasMeta identifies an exported board.
type CanvasMeta struct {
	Format int    `json:"format"`
	ID     string `json:"id"`
	Name   string `json:"name"`
}

// CanvasNodeMeta and CanvasEdgeMeta carry what JSON Canvas has no words for — a card's real kind
// and what it embeds, its payload and stacking order; an edge's line style and its exact endings —
// so a board read back is the board that was written, not an approximation of it.
type CanvasNodeMeta struct {
	Kind    string          `json:"kind"`
	RefType string          `json:"refType,omitempty"`
	RefID   string          `json:"refId,omitempty"`
	Z       int             `json:"z"`
	Data    json.RawMessage `json:"data,omitempty"`
}

type CanvasEdgeMeta struct {
	Style   string `json:"style,omitempty"`
	FromEnd string `json:"fromEnd,omitempty"`
	ToEnd   string `json:"toEnd,omitempty"`
}

type jsonCanvasNode struct {
	ID     string `json:"id"`
	Type   string `json:"type"`
	X      int    `json:"x"`
	Y      int    `json:"y"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Color  string `json:"color,omitempty"`
	Text   string `json:"text,omitempty"`
	File   string `json:"file,omitempty"`
	URL    string `json:"url,omitempty"`
	Label  string `json:"label,omitempty"`

	Companion *CanvasNodeMeta `json:"companion,omitempty"`
}

type jsonCanvasEdge struct {
	ID       string `json:"id"`
	FromNode string `json:"fromNode"`
	ToNode   string `json:"toNode"`
	FromSide string `json:"fromSide,omitempty"`
	ToSide   string `json:"toSide,omitempty"`
	FromEnd  string `json:"fromEnd,omitempty"`
	ToEnd    string `json:"toEnd,omitempty"`
	Color    string `json:"color,omitempty"`
	Label    string `json:"label,omitempty"`

	Companion *CanvasEdgeMeta `json:"companion,omitempty"`
}

func (r *renderer) canvas(c *domain.Canvas) ([]byte, error) {
	nodes, err := r.st.CanvasNodes.ListForCanvas(c.ID)
	if err != nil {
		return nil, fmt.Errorf("export: canvas nodes: %w", err)
	}
	edges, err := r.st.CanvasEdges.ListForCanvas(c.ID)
	if err != nil {
		return nil, fmt.Errorf("export: canvas edges: %w", err)
	}
	sort.SliceStable(nodes, func(i, j int) bool {
		if nodes[i].Z != nodes[j].Z {
			return nodes[i].Z < nodes[j].Z
		}
		return nodes[i].ID < nodes[j].ID
	})
	sort.SliceStable(edges, func(i, j int) bool { return edges[i].ID < edges[j].ID })

	out := jsonCanvas{Nodes: []jsonCanvasNode{}, Edges: []jsonCanvasEdge{}, Companion: &CanvasMeta{Format: FormatVersion, ID: c.ID, Name: r.titles[c.ID]}}
	for _, n := range nodes {
		var data map[string]any
		_ = json.Unmarshal(n.Data, &data)
		str := func(key string) string { s, _ := data[key].(string); return s }
		node := jsonCanvasNode{ID: n.ID, X: round(n.X), Y: round(n.Y), Width: round(n.Width), Height: round(n.Height)}
		if n.Color != nil {
			node.Color = *n.Color
		}
		ref := ""
		if n.RefID != nil {
			ref = *n.RefID
		}
		node.Companion = &CanvasNodeMeta{Kind: n.Kind, RefID: ref, Z: n.Z, Data: compactJSON(n.Data)}
		if n.RefType != nil {
			node.Companion.RefType = *n.RefType
		}
		switch n.Kind {
		case domain.CanvasNodeGroup:
			node.Type, node.Label = "group", str("label")
		case domain.CanvasNodeLink:
			node.Type, node.URL = "link", str("url")
		case domain.CanvasNodeNote, domain.CanvasNodeTask:
			if path, ok := r.paths[ref]; ok {
				node.Type, node.File = "file", path
			} else {
				node.Type, node.Text = "text", "*This "+n.Kind+" is gone.*"
			}
		case domain.CanvasNodeText:
			node.Type, node.Text = "text", str("text")
		case domain.CanvasNodeImage:
			if path, ok := r.paths[ref]; ok {
				node.Type, node.File = "file", path
			} else {
				node.Type, node.Text = "text", orDefault(r.titles[ref], "image")
			}
		default: // event
			node.Type, node.Text = "text", orDefault(orDefault(str("title"), r.titles[ref]), n.Kind)
		}
		out.Nodes = append(out.Nodes, node)
	}
	for _, e := range edges {
		edge := jsonCanvasEdge{ID: e.ID, FromNode: e.FromNodeID, ToNode: e.ToNodeID, Label: e.Label, FromEnd: canvasEnd(e.FromEnd), ToEnd: canvasEnd(e.ToEnd),
			Companion: &CanvasEdgeMeta{Style: e.Style, FromEnd: e.FromEnd, ToEnd: e.ToEnd}}
		if e.FromSide != nil {
			edge.FromSide = *e.FromSide
		}
		if e.ToSide != nil {
			edge.ToSide = *e.ToSide
		}
		if e.Color != nil {
			edge.Color = *e.Color
		}
		out.Edges = append(out.Edges, edge)
	}
	encoded, err := json.MarshalIndent(out, "", "\t")
	if err != nil {
		return nil, err
	}
	return append(encoded, '\n'), nil
}

// compactJSON is a node's payload without insignificant whitespace, or nothing when it has none.
func compactJSON(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 || string(raw) == "null" || string(raw) == "{}" {
		return nil
	}
	var buf bytes.Buffer
	if json.Compact(&buf, raw) != nil {
		return nil
	}
	return buf.Bytes()
}

// canvasEnd maps the app's five edge endings onto JSON Canvas's two.
func canvasEnd(end string) string {
	if end == "" || end == "none" {
		return "none"
	}
	return "arrow"
}

func round(f float64) int {
	if f < 0 {
		return int(f - 0.5)
	}
	return int(f + 0.5)
}
