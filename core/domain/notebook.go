package domain

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Notebooks (PLAN-notebooks.md): a notebook is an ordered run of fixed-size paper pages.
// Each page holds typed markdown and ink on one sheet. Pages are their own entity rather
// than notes: they never show under Notes, are never opened in the note editor, and are
// searched by their text. Three synced entities (notebook, page, ink group) so devices
// editing different pages, or different ink on one page, merge per row.
//
// A notebook is trashable (DeletingAt) like a note. Pages and ink follow it and tombstone
// directly, the way canvas nodes follow their board.

// Notebook is the book itself: a title, a cover, and settings that apply to every page
// (today: the guides dragged out of the rulers).
type Notebook struct {
	ID              string          `json:"id"`
	Title           string          `json:"title"`
	CoverColor      string          `json:"coverColor"`
	CoverDocumentID *string         `json:"coverDocumentId,omitempty"`
	Settings        json.RawMessage `json:"settingsJson,omitempty"`
	SortOrder       int             `json:"sortOrder"`
	CreatedAt       time.Time       `json:"createdAt"`
	UpdatedAt       time.Time       `json:"updatedAt"`
	DeletingAt      *time.Time      `json:"deletingAt,omitempty"`
	DeletedAt       *time.Time      `json:"deletedAt,omitempty"`
	Version         int64           `json:"version"`
	Dirty           bool            `json:"dirty"`
}

// Paper kinds and rule pitches a page may use. The app renders them; the core only checks
// that a page names one of them.
const (
	PaperBlank = "blank"
	PaperLined = "lined"
	PaperGrid  = "grid"
	PaperDots  = "dots"
)

var PaperKinds = map[string]bool{PaperBlank: true, PaperLined: true, PaperGrid: true, PaperDots: true}
var PaperSpacings = map[int]bool{24: true, 28: true, 32: true}

const (
	DefaultPaperKind    = PaperLined
	DefaultPaperSpacing = 28
)

// Mediums (PLAN-notebooks.md §11): what a notebook is made of. Paper is the default and has
// no rules beyond its ruling. The ancient mediums are design constraints with some history
// in them. They are written with a pen only (no typed text): the app keeps each page's marks as
// ink rows in its own stroke format and renders them as impressions, scratches or brushed ink.
//
//   - clay: a run of small tablets, written by pressing a stylus in.
//   - wax: a codex of wooden leaves bound when it is made (a diptych, triptych or polyptych).
//     Leaves are never added or removed (the core refuses both); a leaf is reused by smoothing.
//   - sherd: a heap of potsherds (ostraca). Pick up another when one is full.
//
// The medium and a wax codex's leaf count are chosen when the notebook is made and never
// change. They live in the notebook's (encrypted) settings, beside the guides.
const (
	MediumPaper = "paper"
	MediumClay  = "clay"
	MediumWax   = "wax"
	MediumSherd = "sherd"
)

var NotebookMediums = map[string]bool{MediumPaper: true, MediumClay: true, MediumWax: true, MediumSherd: true}

// WaxLeaves are the bindings a wax codex may have: a diptych, a triptych, a polyptych.
var WaxLeaves = map[int]bool{2: true, 3: true, 8: true}

const DefaultWaxLeaves = 2

// Bindings (PLAN-notebooks.md §12): how a paper notebook is held together. Like a medium, a
// binding is a set of physical rules chosen when the notebook is made and never changed. A
// paper notebook made before bindings (or with the Labs flag off) has none, and keeps the
// original rules: pages added, deleted and re-ruled freely.
//
//   - sewn: a Smyth-sewn journal. Its pages are all there from the start; none added or removed.
//   - spiral: a wire-bound pad. Pages are torn out but never put back in.
//   - topbound: a reporter's pad, spiral-bound along the top. Torn off, never added.
//   - ring: a ring binder. Pages go in anywhere, move about, and move to another binder.
//   - saddle: a stapled pocket notebook. Paper comes in folded sheets of four pages, added at the
//     centre fold and taken out whole.
//   - travelers: a traveler's notebook: booklets under one cover. A booklet can be slipped out.
//   - cards: an index-card box. Cards go in anywhere and are shuffled.
//   - accordion: a concertina. One strip, folded: panels are added and cut off at the end only.
const (
	BindingSewn      = "sewn"
	BindingSpiral    = "spiral"
	BindingTopbound  = "topbound"
	BindingRing      = "ring"
	BindingSaddle    = "saddle"
	BindingTravelers = "travelers"
	BindingCards     = "cards"
	BindingAccordion = "accordion"
)

var NotebookBindings = map[string]bool{
	BindingSewn: true, BindingSpiral: true, BindingTopbound: true, BindingRing: true,
	BindingSaddle: true, BindingTravelers: true, BindingCards: true, BindingAccordion: true,
}

// BindingPageCounts are the sizes a binding is made in, the first being the default. A binding
// missing here starts with one page and grows.
var BindingPageCounts = map[string][]int{
	BindingSewn:     {96, 48, 192},
	BindingSpiral:   {80, 40, 120},
	BindingTopbound: {70, 40, 100},
	BindingSaddle:   {16, 32, 48},
}

// A stapled notebook's paper comes in folded sheets of this many pages, up to SaddleMaxPages.
const (
	SaddleSheetPages = 4
	SaddleMaxPages   = 48
)

// Booklet is one insert in a traveler's notebook: a run of pages starting at FirstPageID and
// ending where the next booklet starts. An archived booklet has been slipped out of the cover:
// its pages are kept, but not shown.
type Booklet struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	FirstPageID string `json:"firstPageId"`
	Archived    bool   `json:"archived,omitempty"`
}

// NotebookSettings is the typed view of settings_json that the core reads. Other keys (the
// app's guides, a sewn journal's ribbon) are carried through untouched. Medium, Leaves and the
// binding's keys are owned by the core: a generic settings update never changes them.
type NotebookSettings struct {
	Medium   string    `json:"medium,omitempty"`
	Leaves   int       `json:"leaves,omitempty"`
	Binding  string    `json:"binding,omitempty"`
	Pages    int       `json:"pages,omitempty"`
	Torn     int       `json:"torn,omitempty"`
	Booklets []Booklet `json:"booklets,omitempty"`
}

// CoreSettingsKeys are the settings keys only the core writes.
var CoreSettingsKeys = map[string]bool{"medium": true, "leaves": true, "binding": true, "pages": true, "torn": true, "booklets": true}

// ParsedSettings reads the core's keys from Settings, leniently: a missing or malformed value
// reads as paper.
func (n *Notebook) ParsedSettings() NotebookSettings {
	var s NotebookSettings
	if len(n.Settings) > 0 {
		_ = json.Unmarshal(n.Settings, &s)
	}
	if !NotebookMediums[s.Medium] {
		s.Medium = MediumPaper
	}
	return s
}

// Medium is the notebook's medium; paper when unset.
func (n *Notebook) Medium() string { return n.ParsedSettings().Medium }

// Binding is a paper notebook's binding; empty for one made without.
func (n *Notebook) Binding() string { return n.ParsedSettings().Binding }

// MaxNotebookPageContent caps a page's markdown. A page is one A5 sheet that grows by whole
// rules, not a document, so this is generous.
const MaxNotebookPageContent = 512 * 1024

// NotebookPage is one sheet: its place in the notebook, its paper, and its text. Ink lives in
// NotebookPageInk rows keyed by the page.
type NotebookPage struct {
	ID           string     `json:"id"`
	NotebookID   string     `json:"notebookId"`
	SortOrder    int        `json:"sortOrder"`
	PaperKind    string     `json:"paperKind"`
	PaperSpacing int        `json:"paperSpacing"`
	ContentMD    string     `json:"contentMd"`
	CreatedAt    time.Time  `json:"createdAt"`
	UpdatedAt    time.Time  `json:"updatedAt"`
	DeletedAt    *time.Time `json:"deletedAt,omitempty"`
	Version      int64      `json:"version"`
	Dirty        bool       `json:"dirty"`
}

// NotebookPageInk is one ink group on a page: the note_ink shape, keyed to a page, with the
// notebook carried alongside so a purged notebook takes its ink in one pass. The payload is
// the editor's (anchor {page: true}, strokes in page coordinates) and is encrypted whole.
type NotebookPageInk struct {
	ID         string          `json:"id"`
	NotebookID string          `json:"notebookId"`
	PageID     string          `json:"pageId"`
	Data       json.RawMessage `json:"data,omitempty"`
	CreatedAt  time.Time       `json:"createdAt"`
	UpdatedAt  time.Time       `json:"updatedAt"`
	DeletedAt  *time.Time      `json:"deletedAt,omitempty"`
	Version    int64           `json:"version"`
	Dirty      bool            `json:"dirty"`
}

var (
	ErrInvalidNotebook        = errors.New("invalid notebook")
	ErrInvalidNotebookPage    = errors.New("invalid notebook page")
	ErrInvalidNotebookPageInk = errors.New("invalid notebook page ink")
)

func (n *Notebook) Validate() error {
	if strings.TrimSpace(n.ID) == "" {
		return errors.Join(ErrInvalidNotebook, errors.New("id is required"))
	}
	if strings.TrimSpace(n.CoverColor) == "" {
		return errors.Join(ErrInvalidNotebook, errors.New("coverColor is required"))
	}
	if len(n.Settings) > 0 && string(n.Settings) != "null" {
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(n.Settings, &obj); err != nil {
			return errors.Join(ErrInvalidNotebook, errors.New("settings must be a JSON object"))
		}
		if raw, ok := obj["medium"]; ok {
			var m string
			if err := json.Unmarshal(raw, &m); err != nil || !NotebookMediums[m] {
				return errors.Join(ErrInvalidNotebook, errors.New("unknown medium"))
			}
			if m == MediumWax {
				var leaves int
				_ = json.Unmarshal(obj["leaves"], &leaves)
				if !WaxLeaves[leaves] {
					return errors.Join(ErrInvalidNotebook, errors.New("a wax codex has 2, 3 or 8 leaves"))
				}
			}
		}
		if raw, ok := obj["binding"]; ok {
			var b string
			if err := json.Unmarshal(raw, &b); err != nil || !NotebookBindings[b] {
				return errors.Join(ErrInvalidNotebook, errors.New("unknown binding"))
			}
			if n.Medium() != MediumPaper {
				return errors.Join(ErrInvalidNotebook, errors.New("only a paper notebook has a binding"))
			}
			if sizes := BindingPageCounts[b]; sizes != nil {
				var pages int
				_ = json.Unmarshal(obj["pages"], &pages)
				if !containsInt(sizes, pages) {
					return errors.Join(ErrInvalidNotebook, errors.New("that binding isn't made in that size"))
				}
			}
		}
	}
	return nil
}

func containsInt(xs []int, x int) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

func (p *NotebookPage) Validate() error {
	if strings.TrimSpace(p.ID) == "" {
		return errors.Join(ErrInvalidNotebookPage, errors.New("id is required"))
	}
	if strings.TrimSpace(p.NotebookID) == "" {
		return errors.Join(ErrInvalidNotebookPage, errors.New("notebookId is required"))
	}
	if !PaperKinds[p.PaperKind] {
		return errors.Join(ErrInvalidNotebookPage, errors.New("unknown paper kind"))
	}
	if !PaperSpacings[p.PaperSpacing] {
		return errors.Join(ErrInvalidNotebookPage, errors.New("unknown paper spacing"))
	}
	if len(p.ContentMD) > MaxNotebookPageContent {
		return errors.Join(ErrInvalidNotebookPage, errors.New("page content too large"))
	}
	return nil
}

// Validate checks an ink group's invariants: a UUID id (the editor picks it), its page and
// notebook, and a JSON-object payload within the note-ink size cap.
func (i *NotebookPageInk) Validate() error {
	if _, err := uuid.Parse(strings.TrimSpace(i.ID)); err != nil {
		return errors.Join(ErrInvalidNotebookPageInk, errors.New("id must be a UUID"))
	}
	if strings.TrimSpace(i.NotebookID) == "" || strings.TrimSpace(i.PageID) == "" {
		return errors.Join(ErrInvalidNotebookPageInk, errors.New("notebookId and pageId are required"))
	}
	if len(i.Data) > MaxNoteInkData {
		return errors.Join(ErrInvalidNotebookPageInk, errors.New("ink data too large"))
	}
	if len(i.Data) > 0 && string(i.Data) != "null" {
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(i.Data, &obj); err != nil {
			return errors.Join(ErrInvalidNotebookPageInk, errors.New("ink data must be a JSON object"))
		}
	}
	return nil
}

// SyncEntity implementations (PLAN §7).
func (n *Notebook) SyncID() string           { return n.ID }
func (n *Notebook) SyncVersion() int64       { return n.Version }
func (n *Notebook) SyncUpdatedAt() time.Time { return n.UpdatedAt }
func (n *Notebook) SyncDeleted() bool        { return n.DeletedAt != nil }
func (n *Notebook) SyncDirty() bool          { return n.Dirty }

func (p *NotebookPage) SyncID() string           { return p.ID }
func (p *NotebookPage) SyncVersion() int64       { return p.Version }
func (p *NotebookPage) SyncUpdatedAt() time.Time { return p.UpdatedAt }
func (p *NotebookPage) SyncDeleted() bool        { return p.DeletedAt != nil }
func (p *NotebookPage) SyncDirty() bool          { return p.Dirty }

func (i *NotebookPageInk) SyncID() string           { return i.ID }
func (i *NotebookPageInk) SyncVersion() int64       { return i.Version }
func (i *NotebookPageInk) SyncUpdatedAt() time.Time { return i.UpdatedAt }
func (i *NotebookPageInk) SyncDeleted() bool        { return i.DeletedAt != nil }
func (i *NotebookPageInk) SyncDirty() bool          { return i.Dirty }
