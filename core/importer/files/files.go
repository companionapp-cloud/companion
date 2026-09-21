// Package files reads markdown and canvas files into the workspace: the one-time "import files"
// flow (a Companion export, an Obsidian vault, any folder of notes) and the incoming half of Git
// sync. It is the inverse of core/export's renderer, through core/export's parser.
//
// Everything lands through the store's ordinary repositories, so an imported item is indexed,
// linked and synced exactly like one typed into the app.
//
// Two rules keep it safe to point at files people edit by hand:
//
//   - An import is a patch. A file says what it says — title, body, the front-matter keys it
//     carries — and only that is written. What a file has no words for (ink, lists, a project's
//     settings, attachments) is never touched, and a key the file doesn't mention is left alone.
//     A key is cleared only when it is present and empty, or (with a Base to compare against)
//     when it was there before and has been removed.
//   - Identity is never taken on trust from another workspace. A file's `id` selects an item only
//     when that item exists here and is of the same kind; otherwise the file makes a new item
//     with a new id.
package files

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"companion/core/domain"
	"companion/core/export"
	"companion/core/store"
)

// File is one file to import.
type File struct {
	// Path is slash-separated and relative to the folder or repository root.
	Path    string
	Content []byte
	// Base is the file's content as of the last sync, when there is one (Git sync). It lets a
	// front-matter key that was removed be told apart from one that was never there.
	Base []byte
	// Load reads an attachment's bytes in place of Content: they are only wanted if the file
	// turns out to be one that's imported.
	Load func() ([]byte, error)
}

// Ingestor stores an attachment's bytes and answers with the document that holds them: a live
// one that already has exactly this content under this name, or a new one. The bridge provides
// it (bytes live in the platform blob store); without one, attachments are left out.
type Ingestor interface {
	Ingest(filename string, content []byte) (docID string, created bool, err error)
}

// Ref names an item.
type Ref struct {
	Type string // note | task | canvas
	ID   string
}

type Options struct {
	// Loc is the zone a date with no time is read in. Defaults to the device's.
	Loc *time.Location
	// UpdateExisting lets a file update the item it names. Off, such files are skipped — the
	// cautious default for a one-time import, which should add to a workspace, not rewrite it.
	UpdateExisting bool
	// Known identifies files by path when they carry no id of their own (Git sync's manifest).
	Known map[string]Ref
	// Attachments takes in the files that notes embed. Nil leaves them out.
	Attachments Ingestor
	// PathsFile makes a file's folder decide where its item is filed, including unfiling one
	// that sits at the root. Off, a recognised Areas/… folder files new items and nothing else
	// moves.
	PathsFile bool
}

// Actions an import can take on a file.
const (
	Created = "created"
	Updated = "updated"
	Skipped = "skipped"
	Failed  = "failed"
)

// Outcome is what happened to one file.
type Outcome struct {
	Path   string `json:"path"`
	Type   string `json:"type,omitempty"`
	ID     string `json:"id,omitempty"`
	Title  string `json:"title,omitempty"`
	Action string `json:"action"`
	// Reason says why a file was skipped or failed.
	Reason string `json:"reason,omitempty"`
}

// Summary counts outcomes.
type Summary struct {
	Notes       int `json:"notes"`
	Tasks       int `json:"tasks"`
	Canvases    int `json:"canvases"`
	Attachments int `json:"attachments"`
	Created     int `json:"created"`
	Updated     int `json:"updated"`
	Skipped     int `json:"skipped"`
	Failed      int `json:"failed"`
}

func Summarize(outcomes []Outcome) Summary {
	var s Summary
	for _, o := range outcomes {
		switch o.Action {
		case Created:
			s.Created++
		case Updated:
			s.Updated++
		case Skipped:
			s.Skipped++
		case Failed:
			s.Failed++
		}
		if o.Action == Created || o.Action == Updated {
			switch o.Type {
			case export.KindNote:
				s.Notes++
			case export.KindTask:
				s.Tasks++
			case "canvas":
				s.Canvases++
			case export.KindDocument:
				s.Attachments++
			}
		}
	}
	return s
}

// maxFile bounds one imported file: a note is text, and these arrive from outside.
const maxFile = 8 << 20

// Importable reports whether a path is an item's file — markdown or a canvas — skipping
// dot-folders (.git, .obsidian, .trash) wherever they sit.
func Importable(path string) bool {
	if hidden(path) {
		return false
	}
	lower := strings.ToLower(path)
	return strings.HasSuffix(lower, ".md") || strings.HasSuffix(lower, ".markdown") || strings.HasSuffix(lower, ".json") || strings.HasSuffix(lower, ".canvas")
}

func hidden(path string) bool {
	for _, segment := range strings.Split(path, "/") {
		if strings.HasPrefix(segment, ".") {
			return true
		}
	}
	return false
}

// attachmentExtensions are the kinds of file a note embeds.
var attachmentExtensions = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".svg": true, ".heic": true, ".avif": true, ".bmp": true, ".tiff": true,
	".pdf": true, ".mp3": true, ".m4a": true, ".wav": true, ".ogg": true, ".flac": true, ".mp4": true, ".mov": true, ".webm": true,
	".csv": true, ".txt": true, ".zip": true, ".docx": true, ".xlsx": true, ".pptx": true, ".key": true, ".pages": true, ".numbers": true,
}

// Attachable reports whether a path could be an attachment: anything in an export's Attachments
// folder, or — anywhere else — a file of a kind notes embed. Whether one outside Attachments is
// actually imported depends on a note referring to it (see read).
func Attachable(path string) bool {
	if hidden(path) || Importable(path) {
		return false
	}
	if export.IsAttachmentPath(path) {
		return true
	}
	if i := strings.LastIndex(path, "."); i > strings.LastIndex(path, "/") {
		return attachmentExtensions[strings.ToLower(path[i:])]
	}
	return false
}

// item is one file on its way in.
type item struct {
	file    File
	kind    string
	doc     export.Document
	canvas  export.ParsedCanvas
	place   export.Place
	title   string
	id      string // the item it updates, or the one created for it
	created bool
	outcome *Outcome
}

// Plan reports what Apply would do, without writing anything.
func Plan(st *store.Store, files []File, opts Options) []Outcome {
	im := &importer{st: st, opts: opts}
	items := im.read(files)
	out := make([]Outcome, 0, len(items))
	for _, it := range items {
		if it.outcome.Action == "" {
			it.outcome.Action = Created
			if it.id != "" {
				it.outcome.Action = Updated
			}
		}
		out = append(out, *it.outcome)
	}
	return out
}

// ingest takes in the batch's attachments, before any note is written, so the notes' embeds have
// documents to point at.
func (im *importer) ingest(items []*item) {
	for _, it := range items {
		if it.kind != export.KindDocument || it.outcome.Action != "" {
			continue
		}
		content := it.file.Content
		if it.file.Load != nil {
			var err error
			if content, err = it.file.Load(); err != nil {
				it.outcome.Action, it.outcome.Reason = Failed, err.Error()
				continue
			}
		}
		id, created, err := im.opts.Attachments.Ingest(it.title, content)
		if err != nil {
			it.outcome.Action, it.outcome.Reason = Failed, err.Error()
			continue
		}
		it.id, it.created = id, created
		it.outcome.Action = Updated
		if created {
			it.outcome.Action = Created
		}
		// The file at a path Companion already tracks has new bytes: the attachment was
		// replaced. Everything that embedded the old one now embeds this, and the old goes to
		// the Trash.
		if known, ok := im.opts.Known[it.file.Path]; ok && known.Type == export.KindDocument && known.ID != "" && known.ID != id {
			if err := im.repoint(known.ID, id); err != nil {
				it.outcome.Action, it.outcome.Reason = Failed, err.Error()
				continue
			}
			_ = Trash(im.st, known)
		}
	}
}

// repoint makes everything that embeds one document embed another instead.
func (im *importer) repoint(from, to string) error {
	notes, err := im.st.Notes.List()
	if err != nil {
		return err
	}
	for _, n := range notes {
		if strings.Contains(n.ContentMD, "doc:"+from) {
			body := strings.ReplaceAll(n.ContentMD, "doc:"+from, "doc:"+to)
			if _, err := im.st.Notes.Update(n.ID, store.UpdateNoteInput{ContentMD: &body}); err != nil {
				return err
			}
		}
	}
	tasks, err := im.st.Tasks.List()
	if err != nil {
		return err
	}
	for _, t := range tasks {
		if strings.Contains(t.NotesMD, "doc:"+from) {
			body := strings.ReplaceAll(t.NotesMD, "doc:"+from, "doc:"+to)
			if _, err := im.st.Tasks.Update(t.ID, store.UpdateTaskInput{NotesMD: &body}); err != nil {
				return err
			}
		}
	}
	canvases, err := im.st.Canvases.List()
	if err != nil {
		return err
	}
	for _, c := range canvases {
		nodes, err := im.st.CanvasNodes.ListForCanvas(c.ID)
		if err != nil {
			return err
		}
		var moved []store.CanvasNodeInput
		for _, n := range nodes {
			if n.RefID != nil && *n.RefID == from {
				ref := to
				moved = append(moved, store.CanvasNodeInput{ID: n.ID, Kind: n.Kind, X: n.X, Y: n.Y, Width: n.Width, Height: n.Height, Z: n.Z, Color: n.Color, RefType: n.RefType, RefID: &ref, Data: n.Data})
			}
		}
		if len(moved) > 0 {
			if _, err := im.st.CanvasNodes.UpsertMany(c.ID, moved); err != nil {
				return err
			}
		}
	}
	return nil
}

// Apply imports the files and reports what happened to each. One bad file never stops the rest.
func Apply(st *store.Store, files []File, opts Options) []Outcome {
	im := &importer{st: st, opts: opts}
	items := im.read(files)
	im.ingest(items)

	// New items first, as stubs, so that every file has an id before any body is written: a
	// link between two files in the same import then resolves whichever comes first.
	for _, it := range items {
		if it.outcome.Action != "" || it.id != "" || it.kind == export.KindDocument {
			continue
		}
		if err := im.create(it); err != nil {
			it.outcome.Action, it.outcome.Reason = Failed, err.Error()
		}
	}
	resolver := im.resolver(items)
	for _, it := range items {
		if it.outcome.Action != "" || it.kind == export.KindDocument {
			continue
		}
		if err := im.write(it, resolver); err != nil {
			it.outcome.Action, it.outcome.Reason = Failed, err.Error()
			continue
		}
		it.outcome.Action = Updated
		if it.created {
			it.outcome.Action = Created
		}
	}
	out := make([]Outcome, 0, len(items))
	for _, it := range items {
		it.outcome.ID, it.outcome.Title = it.id, it.title
		out = append(out, *it.outcome)
	}
	return out
}

type importer struct {
	st   *store.Store
	opts Options
	// madeAreas are the areas this import created, which it may still name properly.
	madeAreas map[string]bool
}

func (im *importer) loc() *time.Location {
	if im.opts.Loc != nil {
		return im.opts.Loc
	}
	return time.Local
}

// read parses every file and works out which item, if any, each one already is.
func (im *importer) read(files []File) []*item {
	sort.SliceStable(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	items := make([]*item, 0, len(files))
	for _, f := range files {
		it := &item{file: f, place: export.PlaceOf(f.Path), outcome: &Outcome{Path: f.Path}}
		items = append(items, it)
		if Attachable(f.Path) {
			it.kind, it.title = export.KindDocument, f.Path[strings.LastIndex(f.Path, "/")+1:]
			it.outcome.Type, it.outcome.Title = it.kind, it.title
			if im.opts.Attachments == nil {
				it.outcome.Action, it.outcome.Reason = Skipped, "attachments aren’t imported here"
			}
			continue
		}
		if len(f.Content) > maxFile {
			it.outcome.Action, it.outcome.Reason = Failed, "the file is too large to be a note"
			continue
		}
		lower := strings.ToLower(f.Path)
		if strings.HasSuffix(lower, ".json") || strings.HasSuffix(lower, ".canvas") {
			canvas, err := export.ParseCanvas(f.Content)
			if err != nil {
				it.outcome.Action, it.outcome.Reason = Skipped, "not a canvas"
				continue
			}
			// Any JSON file parses as an empty board; only take ones that look like a canvas.
			if canvas.ID == "" && len(canvas.Nodes) == 0 {
				it.outcome.Action, it.outcome.Reason = Skipped, "not a canvas"
				continue
			}
			it.kind, it.canvas = "canvas", canvas
			it.title = firstNonEmpty(canvas.Name, it.place.Stem)
			it.id = im.existing("canvas", canvas.ID, f.Path)
		} else {
			doc, err := export.ParseMarkdown(f.Content)
			if err != nil {
				it.outcome.Action, it.outcome.Reason = Failed, err.Error()
				continue
			}
			it.doc = doc
			switch kind := strings.ToLower(doc.Get("kind")); {
			case kind == export.KindNote || kind == export.KindTask:
				it.kind = kind
			case it.place.Kind == export.KindNote || it.place.Kind == export.KindTask:
				it.kind = it.place.Kind
			default:
				it.kind = export.KindNote
			}
			it.title = firstNonEmpty(doc.Get("title"), it.place.Stem)
			it.id = im.existing(it.kind, doc.Get("id"), f.Path)
		}
		it.outcome.Type, it.outcome.Title, it.outcome.ID = it.kind, it.title, it.id
		if it.id != "" && !im.opts.UpdateExisting {
			it.outcome.Action, it.outcome.Reason = Skipped, "already in Companion"
		}
	}
	im.dropUnreferenced(items)
	return items
}

// dropUnreferenced leaves out attachments nothing refers to. An export's Attachments folder is
// taken whole; anywhere else — a vault with images beside its notes — a file only comes along if
// one of the notes being imported embeds it. A folder of notes usually sits among files that
// have nothing to do with them.
func (im *importer) dropUnreferenced(items []*item) {
	candidates := export.NewResolver()
	for _, it := range items {
		if it.kind == export.KindDocument && it.outcome.Action == "" && !export.IsAttachmentPath(it.file.Path) {
			candidates.AddFile(it.file.Path, export.LinkTarget{Type: "doc", ID: it.file.Path})
		}
	}
	referenced := map[string]bool{}
	for _, it := range items {
		if it.kind != export.KindNote && it.kind != export.KindTask {
			continue
		}
		resolved := candidates.ResolveFrom(it.doc.Body, dirOf(it.file.Path))
		for _, m := range referencedDoc.FindAllStringSubmatch(resolved, -1) {
			referenced[m[1]] = true
		}
	}
	for _, it := range items {
		if it.kind == export.KindDocument && it.outcome.Action == "" && !export.IsAttachmentPath(it.file.Path) && !referenced[it.file.Path] {
			it.outcome.Action, it.outcome.Reason = Skipped, "no note uses it"
		}
	}
}

// referencedDoc finds the placeholder links dropUnreferenced's resolver writes: [[doc:<path>]].
var referencedDoc = regexp.MustCompile(`\[\[doc:([^\]|]+)`)

func dirOf(path string) string {
	if i := strings.LastIndex(path, "/"); i >= 0 {
		return path[:i]
	}
	return ""
}

// existing is the live item a file refers to — by its own id, else by its path — or "".
func (im *importer) existing(kind, id, path string) string {
	candidates := []string{id}
	if known, ok := im.opts.Known[path]; ok && known.Type == kind {
		candidates = append(candidates, known.ID)
	}
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		var err error
		switch kind {
		case export.KindNote:
			_, err = im.st.Notes.Get(candidate)
		case export.KindTask:
			_, err = im.st.Tasks.Get(candidate)
		case "canvas":
			_, err = im.st.Canvases.Get(candidate)
		}
		if err == nil {
			return candidate
		}
	}
	return ""
}

func (im *importer) create(it *item) error {
	switch it.kind {
	case export.KindNote:
		n, err := im.st.Notes.Create(store.CreateNoteInput{Title: it.title})
		if err != nil {
			return err
		}
		it.id = n.ID
	case export.KindTask:
		t, err := im.st.Tasks.Create(store.CreateTaskInput{Title: it.title})
		if err != nil {
			return err
		}
		it.id = t.ID
	case "canvas":
		c, err := im.st.Canvases.Create(store.CreateCanvasInput{Name: it.title})
		if err != nil {
			return err
		}
		it.id = c.ID
	}
	it.created = true
	return nil
}

// resolver knows everything a link in an imported file might name: what's already in the
// workspace, by title, and the files of this import, by title and by path.
func (im *importer) resolver(items []*item) *export.Resolver {
	r := export.NewResolver()
	if notes, err := im.st.Notes.List(); err == nil {
		for _, n := range notes {
			r.AddTitle(n.Title, export.LinkTarget{Type: "note", ID: n.ID})
		}
	}
	if tasks, err := im.st.Tasks.List(); err == nil {
		for _, t := range tasks {
			r.AddTitle(t.Title, export.LinkTarget{Type: "task", ID: t.ID})
		}
	}
	if canvases, err := im.st.Canvases.List(); err == nil {
		for _, c := range canvases {
			r.AddTitle(c.Name, export.LinkTarget{Type: "canvas", ID: c.ID})
		}
	}
	if projects, err := im.st.Projects.List(); err == nil {
		for _, p := range projects {
			r.AddTitle(p.Name, export.LinkTarget{Type: "project", ID: p.ID})
		}
	}
	if docs, err := im.st.Documents.List(); err == nil {
		for _, d := range docs {
			r.AddTitle(d.Filename, export.LinkTarget{Type: "doc", ID: d.ID})
		}
	}
	for _, it := range items {
		if it.id == "" {
			continue
		}
		if it.kind == export.KindDocument {
			r.AddFile(it.file.Path, export.LinkTarget{Type: "doc", ID: it.id})
			continue
		}
		target := export.LinkTarget{Type: it.kind, ID: it.id}
		r.AddTitle(it.title, target)
		r.AddPath(it.file.Path, target)
	}
	return r
}

func (im *importer) write(it *item, links *export.Resolver) error {
	var err error
	switch it.kind {
	case export.KindNote:
		err = im.writeNote(it, links)
	case export.KindTask:
		err = im.writeTask(it, links)
	case "canvas":
		err = im.writeCanvas(it, links)
	}
	if err != nil {
		return err
	}
	return im.file(it)
}

// base is the file's front matter as of the last sync, when known.
func (it *item) base() export.Document {
	if it.file.Base == nil {
		return export.Document{}
	}
	doc, _ := export.ParseMarkdown(it.file.Base)
	return doc
}

// field reads a front-matter key as a patch: set (present with a value), cleared (present and
// empty, or removed since the base), or untouched.
func (it *item) field(key string) (value string, set, cleared bool) {
	if it.doc.Has(key) {
		v := it.doc.Get(key)
		return v, v != "", v == ""
	}
	return "", false, it.base().Has(key)
}

func (im *importer) writeNote(it *item, links *export.Resolver) error {
	body := links.ResolveFrom(it.doc.Body, dirOf(it.file.Path))
	in := store.UpdateNoteInput{Title: &it.title, ContentMD: &body}
	if date, set, cleared := it.field("date"); set {
		if _, err := time.Parse("2006-01-02", date); err == nil {
			in.Date = &date
		}
	} else if cleared {
		empty := ""
		in.Date = &empty
	}
	existing, err := im.st.Notes.Get(it.id)
	if err != nil {
		return err
	}
	in.ObjectTypeID, in.ClearObjectType, in.Props = im.archetype(it, export.KindNote, existing.ObjectTypeID, existing.Props, links)
	if _, err := im.st.Notes.Update(it.id, in); err != nil {
		// Props the schema won't take (a select value it doesn't list) shouldn't lose the note.
		in.ObjectTypeID, in.ClearObjectType, in.Props = nil, false, nil
		if _, err := im.st.Notes.Update(it.id, in); err != nil {
			return err
		}
	}
	return nil
}

func (im *importer) writeTask(it *item, links *export.Resolver) error {
	body := links.ResolveFrom(it.doc.Body, dirOf(it.file.Path))
	in := store.UpdateTaskInput{Title: &it.title, NotesMD: &body}
	if status, set, _ := it.field("status"); set {
		switch status = strings.ToLower(status); status {
		case "open", "done", "cancelled":
			in.Status = &status
		case "canceled":
			status = "cancelled"
			in.Status = &status
		}
	}
	if start, set, cleared := it.field("start"); set {
		someday := strings.EqualFold(start, "someday")
		in.Someday = &someday
		if someday {
			in.ClearStartAt = true
		} else if t, ok := export.ParseWhen(start, im.loc()); ok {
			in.StartAt = &t
		}
	} else if cleared {
		someday := false
		in.Someday, in.ClearStartAt = &someday, true
	}
	if deadline, set, cleared := it.field("deadline"); set {
		if t, ok := export.ParseWhen(deadline, im.loc()); ok {
			in.DueAt = &t
		}
	} else if cleared {
		in.ClearDueAt = true
	}
	if repeat, set, cleared := it.field("repeat"); set {
		// Only a rule is a rule: a one-off markdown export describes it in words instead.
		if rule := strings.TrimPrefix(strings.ToUpper(repeat), "RRULE:"); strings.HasPrefix(rule, "FREQ=") {
			in.RepeatRule = &rule
		}
	} else if cleared {
		in.ClearRepeatRule = true
	}
	if it.doc.Has("reminders") || it.base().Has("reminders") {
		reminders := []domain.Reminder{}
		for _, r := range it.doc.Strings("reminders") {
			if lead := strings.ToUpper(strings.TrimSpace(r)); strings.HasPrefix(lead, "P") {
				reminders = append(reminders, domain.Reminder{Before: lead})
			} else if t, ok := export.ParseWhen(r, im.loc()); ok {
				at := t.UTC()
				reminders = append(reminders, domain.Reminder{At: &at})
			}
		}
		in.Reminders = &reminders
	}
	existing, err := im.st.Tasks.Get(it.id)
	if err != nil {
		return err
	}
	in.ObjectTypeID, in.ClearObjectType, in.Props = im.archetype(it, export.KindTask, existing.ObjectTypeID, existing.Props, links)
	if _, err := im.st.Tasks.Update(it.id, in); err != nil {
		in.ObjectTypeID, in.ClearObjectType, in.Props = nil, false, nil
		if _, err := im.st.Tasks.Update(it.id, in); err != nil {
			return err
		}
	}
	return nil
}

// reserved are the front-matter keys that belong to the item itself; every other key can only
// be a property of its object type.
var reserved = map[string]bool{"title": true, "kind": true, "id": true, "type": true, "date": true, "created": true, "updated": true, "filed_in": true,
	"status": true, "start": true, "deadline": true, "repeat": true, "reminders": true, "completed": true}

// archetype reads `type` and the properties that go with it (PLAN §6.3). The type is matched by
// name; properties are read per their schema and merged over the ones the item has.
func (im *importer) archetype(it *item, kind string, currentType *string, currentProps json.RawMessage, links *export.Resolver) (typeID *string, clearType bool, props *json.RawMessage) {
	name, set, cleared := it.field("type")
	if cleared && currentType != nil {
		return nil, true, nil
	}
	var ot *domain.ObjectType
	types, err := im.st.ObjectTypes.List()
	if err != nil {
		return nil, false, nil
	}
	for _, candidate := range types {
		applies := candidate.AppliesTo == domain.AppliesToBoth || candidate.AppliesTo == kind
		if set && applies && strings.EqualFold(candidate.Name, name) {
			ot = candidate
		} else if !set && currentType != nil && candidate.ID == *currentType {
			ot = candidate
		}
	}
	if ot == nil {
		return nil, false, nil
	}
	schema, err := domain.ParseSchema(ot.SchemaJSON)
	if err != nil {
		return &ot.ID, false, nil
	}
	values := map[string]any{}
	if currentType != nil && *currentType == ot.ID {
		_ = json.Unmarshal(currentProps, &values)
	}
	for _, f := range schema.Fields {
		if reserved[f.Key] || !it.doc.Has(f.Key) {
			continue
		}
		raw := it.doc.Get(f.Key)
		switch f.Type {
		case "multi_select":
			values[f.Key] = it.doc.Strings(f.Key)
		case "number":
			var n float64
			if _, err := fmt.Sscan(raw, &n); err == nil {
				values[f.Key] = n
			}
		case "checkbox":
			values[f.Key] = strings.EqualFold(raw, "true") || strings.EqualFold(raw, "yes")
		case "reference":
			// A reference reads as a title; find the one thing it names.
			resolved := links.Resolve("[[" + raw + "]]")
			if _, id, ok := strings.Cut(strings.TrimSuffix(strings.TrimPrefix(resolved, "[["), "]]"), ":"); ok && !strings.Contains(id, "|") {
				values[f.Key] = id
			}
		default:
			if raw == "" {
				delete(values, f.Key)
			} else {
				values[f.Key] = raw
			}
		}
	}
	encoded, err := json.Marshal(values)
	if err != nil {
		return &ot.ID, false, nil
	}
	rawProps := json.RawMessage(encoded)
	return &ot.ID, false, &rawProps
}

func (im *importer) writeCanvas(it *item, links *export.Resolver) error {
	if _, err := im.st.Canvases.Update(it.id, store.UpdateCanvasInput{Name: &it.title}); err != nil {
		return err
	}
	current, err := im.st.CanvasNodes.ListForCanvas(it.id)
	if err != nil {
		return err
	}
	mine := map[string]bool{}
	for _, n := range current {
		mine[n.ID] = true
	}
	// A node id belongs to one board. On this board it is kept, so an edit lands on the same
	// card; anywhere else (a copied file, another workspace) the card gets an id of its own.
	ids := map[string]string{}
	keep := map[string]bool{}
	var nodes []store.CanvasNodeInput
	for _, n := range it.canvas.Nodes {
		id := n.ID
		if !mine[id] {
			if _, err := uuid.Parse(id); err != nil || im.nodeExistsElsewhere(id) {
				id = uuid.NewString()
			}
		}
		ids[n.ID] = id
		keep[id] = true
		in := store.CanvasNodeInput{ID: id, Kind: n.Kind, X: n.X, Y: n.Y, Width: n.Width, Height: n.Height, Z: n.Z, Data: n.Data}
		if n.Color != "" {
			color := n.Color
			in.Color = &color
		}
		if n.RefType != "" && n.RefID != "" {
			refType, refID := n.RefType, n.RefID
			// A card embeds a note or a task by id, and ids don't travel between workspaces:
			// where the id means nothing here, the file the card points at says which item.
			if (n.Kind == export.KindNote || n.Kind == export.KindTask) && im.existing(n.Kind, refID, "") == "" {
				if target, ok := links.ByPath(n.File); ok && target.Type == n.Kind {
					refID = target.ID
				}
			}
			if n.Kind == "image" {
				if _, err := im.st.Documents.Get(refID); err != nil {
					if target, ok := links.File(n.File); ok {
						refID = target.ID
					}
				}
			}
			in.RefType, in.RefID = &refType, &refID
		}
		nodes = append(nodes, in)
	}
	var gone []string
	for _, n := range current {
		if !keep[n.ID] {
			gone = append(gone, n.ID)
		}
	}
	if len(gone) > 0 {
		if _, err := im.st.CanvasEdges.DeleteForNodes(gone); err != nil {
			return err
		}
		if _, err := im.st.CanvasNodes.DeleteMany(gone); err != nil {
			return err
		}
	}
	if _, err := im.st.CanvasNodes.UpsertMany(it.id, nodes); err != nil {
		return err
	}

	currentEdges, err := im.st.CanvasEdges.ListForCanvas(it.id)
	if err != nil {
		return err
	}
	mineEdges := map[string]bool{}
	for _, e := range currentEdges {
		mineEdges[e.ID] = true
	}
	keepEdges := map[string]bool{}
	var edges []store.CanvasEdgeInput
	for _, e := range it.canvas.Edges {
		from, to := ids[e.From], ids[e.To]
		if from == "" || to == "" {
			continue
		}
		id := e.ID
		if _, err := uuid.Parse(id); !mineEdges[id] && (err != nil || it.created) {
			id = uuid.NewString()
		}
		keepEdges[id] = true
		in := store.CanvasEdgeInput{ID: id, FromNodeID: from, ToNodeID: to, FromEnd: firstNonEmpty(e.FromEnd, "none"), ToEnd: firstNonEmpty(e.ToEnd, "arrow"), Style: firstNonEmpty(e.Style, "curved"), Label: e.Label}
		if e.FromSide != "" {
			side := e.FromSide
			in.FromSide = &side
		}
		if e.ToSide != "" {
			side := e.ToSide
			in.ToSide = &side
		}
		if e.Color != "" {
			color := e.Color
			in.Color = &color
		}
		edges = append(edges, in)
	}
	var goneEdges []string
	for _, e := range currentEdges {
		if !keepEdges[e.ID] {
			goneEdges = append(goneEdges, e.ID)
		}
	}
	if len(goneEdges) > 0 {
		if _, err := im.st.CanvasEdges.DeleteMany(goneEdges); err != nil {
			return err
		}
	}
	_, err = im.st.CanvasEdges.UpsertMany(it.id, edges)
	return err
}

func (im *importer) nodeExistsElsewhere(id string) bool {
	n, err := im.st.CanvasNodes.GetAny(id)
	return err == nil && n != nil
}

// file puts the item where its folder says. A new item is filed under a recognised
// Areas/<area>[/<project>] folder — made if it doesn't exist yet. With PathsFile an existing item
// follows its file too, and one moved to the root is unfiled.
func (im *importer) file(it *item) error {
	if !it.created && !im.opts.PathsFile {
		return nil
	}
	if it.place.Area == "" {
		if !it.created && im.opts.PathsFile && it.place.Kind != "" {
			return im.unfile(it)
		}
		return nil
	}
	area, err := im.area(it.place.Area)
	if err != nil {
		return err
	}
	// A folder's name is the container's name made safe for a filesystem ("Launch: v2" is the
	// folder "Launch v2"). When the file says what it's filed in, and that name makes this
	// folder, a container made for it gets its real name back.
	named := func(folder string) string {
		if name := it.doc.Get("filed_in"); name != "" && strings.EqualFold(export.Segment(name, ""), folder) {
			return name
		}
		return folder
	}
	if it.place.Project == "" {
		if area.Name == it.place.Area && named(it.place.Area) != area.Name && im.madeAreas[area.ID] {
			name := named(it.place.Area)
			if renamed, err := im.st.Areas.Update(area.ID, store.UpdateAreaInput{Name: &name}); err == nil {
				area = renamed
			}
		}
		if im.filedIn(it, area.ID) {
			return nil
		}
		_, err = im.st.ProjectMembers.AddToArea(area.ID, it.kind, it.id)
		return err
	}
	project, err := im.project(area.ID, it.place.Project, named(it.place.Project))
	if err != nil {
		return err
	}
	if im.filedIn(it, project.ID) {
		return nil
	}
	_, err = im.st.ProjectMembers.Add(project.ID, it.kind, it.id)
	return err
}

func (im *importer) filedIn(it *item, containerID string) bool {
	members, err := im.st.ProjectMembers.ListForEntity(it.kind, it.id)
	if err != nil {
		return false
	}
	for _, m := range members {
		if m.ProjectID == containerID {
			return true
		}
	}
	return false
}

func (im *importer) unfile(it *item) error {
	members, err := im.st.ProjectMembers.ListForEntity(it.kind, it.id)
	if err != nil {
		return err
	}
	for _, m := range members {
		if err := im.st.ProjectMembers.Remove(m.ProjectID, it.kind, it.id); err != nil {
			return err
		}
	}
	return nil
}

// area finds an area by the name its folder bears (a folder name is the area's name made safe
// for a filesystem, so compare in that form), or makes one.
func (im *importer) area(folder string) (*domain.Area, error) {
	areas, err := im.st.Areas.List()
	if err != nil {
		return nil, err
	}
	for _, a := range areas {
		if strings.EqualFold(export.Segment(a.Name, "Area"), folder) {
			return a, nil
		}
	}
	area, err := im.st.Areas.Create(store.CreateAreaInput{Name: folder, SortOrder: len(areas)})
	if err == nil {
		if im.madeAreas == nil {
			im.madeAreas = map[string]bool{}
		}
		im.madeAreas[area.ID] = true
	}
	return area, err
}

func (im *importer) project(areaID, folder, name string) (*domain.Project, error) {
	projects, err := im.st.Projects.List()
	if err != nil {
		return nil, err
	}
	count := 0
	for _, p := range projects {
		if p.AreaID != areaID {
			continue
		}
		count++
		if strings.EqualFold(export.Segment(p.Name, "Project"), folder) {
			return p, nil
		}
	}
	return im.st.Projects.Create(store.CreateProjectInput{AreaID: areaID, Name: name, SortOrder: count})
}

// Trash moves the item a deleted file stood for to the Trash — never a hard delete: a file can
// go missing for reasons that have nothing to do with the user wanting the note gone, and the
// Trash keeps it recoverable for thirty days.
func Trash(st *store.Store, ref Ref) error {
	var err error
	switch ref.Type {
	case export.KindNote:
		err = st.Notes.Trash(ref.ID)
	case export.KindTask:
		err = st.Tasks.Trash(ref.ID)
	case "canvas":
		err = st.Canvases.Trash(ref.ID)
	case export.KindDocument:
		err = st.Documents.Trash(ref.ID)
	default:
		return fmt.Errorf("unknown item type %q", ref.Type)
	}
	if errors.Is(err, store.ErrNotFound) {
		return nil // already gone
	}
	return err
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
