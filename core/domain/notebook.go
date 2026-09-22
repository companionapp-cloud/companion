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
	}
	return nil
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
