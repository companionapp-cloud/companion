package bridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"companion/core/domain"
	"companion/core/store"

	"github.com/google/uuid"
)

// Notebooks (PLAN-notebooks.md): the book, its pages, and the ink on each page. Pages are not
// notes: nothing here touches the notes repo, membership or the link index.

// notebooksChangedEvent signals the shelf and an open notebook to refetch after a book or
// page mutation. Payload: {notebookId} (empty on bulk changes). Ink writes use the finer
// notebookInkChangedEvent instead, so a drawing burst never refreshes the shelf.
const notebooksChangedEvent = "notebooks.changed"
const notebookInkChangedEvent = "notebooks.ink.changed"

func (c *Core) emitNotebookChanged(notebookID string) {
	payload, _ := json.Marshal(map[string]string{"notebookId": notebookID})
	c.emit(notebooksChangedEvent, payload)
	c.emitDataChanged("notebook", notebookID)
}

func (c *Core) emitNotebookInkChanged(pageID string) {
	payload, _ := json.Marshal(map[string]string{"pageId": pageID})
	c.emit(notebookInkChangedEvent, payload)
}

// notebookSummary is a shelf entry: the book plus its page count.
type notebookSummary struct {
	*domain.Notebook
	PageCount int `json:"pageCount"`
}

// notebookDocument is the wire shape of notebooks.get: the book and its pages in order
// (page text included; ink is fetched per page as it comes on screen).
type notebookDocument struct {
	Notebook *domain.Notebook       `json:"notebook"`
	Pages    []*domain.NotebookPage `json:"pages"`
}

// ---- books -----------------------------------------------------------------------------

func (c *Core) notebooksList() ([]byte, error) {
	books, err := c.store.Notebooks.List()
	if err != nil {
		return nil, err
	}
	out := make([]notebookSummary, 0, len(books))
	for _, n := range books {
		pages, err := c.store.NotebookPages.ListForNotebook(n.ID)
		if err != nil {
			return nil, err
		}
		out = append(out, notebookSummary{Notebook: n, PageCount: len(pages)})
	}
	return json.Marshal(out)
}

func (c *Core) notebooksGet(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	n, err := c.store.Notebooks.Get(args.ID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	pages, err := c.store.NotebookPages.ListForNotebook(n.ID)
	if err != nil {
		return nil, err
	}
	return json.Marshal(notebookDocument{Notebook: n, Pages: pages})
}

// notebooksCreate makes a book with one page on the default paper (a notebook is never
// empty: the first page is where you start writing).
func (c *Core) notebooksCreate(payload []byte) ([]byte, error) {
	var in store.CreateNotebookInput
	if err := unmarshal(payload, &in); err != nil {
		return nil, err
	}
	n, err := c.store.Notebooks.Create(in)
	if err != nil {
		return nil, err
	}
	// A wax codex is bound with all its leaves, and a sewn journal, a pad or a stapled notebook
	// with all its pages; everything else starts with one page.
	s := n.ParsedSettings()
	count := 1
	if s.Medium == domain.MediumWax {
		count = s.Leaves
	} else if s.Pages > 0 {
		count = s.Pages
	}
	paper := store.AddPageInput{NotebookID: n.ID}
	if s.Binding == domain.BindingCards {
		// An index card is lined, narrowly.
		paper.PaperKind, paper.PaperSpacing = domain.PaperLined, 24
	}
	var first *domain.NotebookPage
	for i := 0; i < count; i++ {
		page := paper
		if i == 0 {
			page.ID = in.FirstPageID
		}
		p, err := c.store.NotebookPages.Add(page)
		if err != nil {
			return nil, err
		}
		if i == 0 {
			first = p
		}
	}
	// A traveler's notebook comes with one booklet in it.
	if s.Binding == domain.BindingTravelers {
		s.Booklets = []domain.Booklet{{ID: newID(), Title: "Booklet 1", FirstPageID: first.ID}}
		if n, err = c.store.Notebooks.SetCoreSettings(n.ID, s); err != nil {
			return nil, err
		}
	}
	c.emitNotebookChanged(n.ID)
	return json.Marshal(n)
}

func newID() string {
	id, _ := uuid.NewV7()
	return id.String()
}

func (c *Core) notebooksUpdate(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
		store.UpdateNotebookInput
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	n, err := c.store.Notebooks.Update(args.ID, args.UpdateNotebookInput)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitNotebookChanged(n.ID)
	return json.Marshal(n)
}

func (c *Core) notebooksReorder(payload []byte) ([]byte, error) {
	var args struct {
		IDs []string `json:"ids"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if err := c.store.Notebooks.Reorder(args.IDs); err != nil {
		return nil, err
	}
	c.emitNotebookChanged("")
	return json.Marshal(map[string]bool{"ok": true})
}

// notebooksDelete moves a book to the Trash. Its pages and ink ride along and come back with
// it; only a purge tombstones them.
func (c *Core) notebooksDelete(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if err := c.store.Notebooks.Trash(args.ID); err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitNotebookChanged(args.ID)
	return json.Marshal(map[string]bool{"ok": true})
}

// purgeNotebook tombstones a trashed book and every page and ink group in it so they stop
// syncing (the server's collector does the same when retention elapses).
func (c *Core) purgeNotebook(id string) error {
	if err := c.store.NotebookInk.DeleteForNotebook(id); err != nil {
		return err
	}
	if err := c.store.NotebookPages.DeleteForNotebook(id); err != nil {
		return err
	}
	return c.store.Notebooks.Delete(id)
}

// ---- pages -----------------------------------------------------------------------------

func (c *Core) notebooksPagesAdd(payload []byte) ([]byte, error) {
	var in store.AddPageInput
	if err := unmarshal(payload, &in); err != nil {
		return nil, err
	}
	n, err := c.store.Notebooks.Get(in.NotebookID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	if n.Medium() == domain.MediumWax {
		return nil, errWaxLeaves
	}
	var p *domain.NotebookPage
	switch n.Binding() {
	case domain.BindingSewn, domain.BindingSpiral, domain.BindingTopbound:
		return nil, errBoundPages
	case domain.BindingAccordion:
		// A concertina only grows at its end.
		in.AfterID = ""
		p, err = c.store.NotebookPages.Add(in)
	case domain.BindingSaddle:
		p, err = c.addSaddleSheet(n.ID, in)
	default:
		p, err = c.store.NotebookPages.Add(in)
	}
	if err != nil {
		return nil, err
	}
	_ = c.store.Notebooks.Touch(in.NotebookID)
	c.emitNotebookChanged(in.NotebookID)
	return json.Marshal(p)
}

// addSaddleSheet folds a new sheet into a stapled notebook: four pages at the centre fold,
// where a sheet slipped under the staples lands. Returns the first of them.
func (c *Core) addSaddleSheet(notebookID string, in store.AddPageInput) (*domain.NotebookPage, error) {
	pages, err := c.store.NotebookPages.ListForNotebook(notebookID)
	if err != nil {
		return nil, err
	}
	if len(pages)+domain.SaddleSheetPages > domain.SaddleMaxPages {
		return nil, fmt.Errorf("a stapled notebook holds %d pages at most: the staples won't go through more", domain.SaddleMaxPages)
	}
	after := ""
	if mid := len(pages) / 2; mid > 0 {
		after = pages[mid-1].ID
	}
	var first *domain.NotebookPage
	for i := 0; i < domain.SaddleSheetPages; i++ {
		page := store.AddPageInput{NotebookID: notebookID, AfterID: after, PaperKind: in.PaperKind, PaperSpacing: in.PaperSpacing}
		if i == 0 {
			page.ID = in.ID
		}
		p, err := c.store.NotebookPages.Add(page)
		if err != nil {
			return nil, err
		}
		if first == nil {
			first = p
		}
		after = p.ID
	}
	return first, nil
}

func (c *Core) notebooksPagesGet(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	p, err := c.store.NotebookPages.Get(args.ID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	return json.Marshal(p)
}

// notebooksPagesUpdate saves a page's text or paper. Text saves are frequent (the editor
// autosaves), so only the page's own event fires; the shelf's recency is bumped without a push.
func (c *Core) notebooksPagesUpdate(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
		store.UpdatePageInput
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if _, _, err := c.writablePage(args.ID); err != nil {
		return nil, err
	}
	p, err := c.store.NotebookPages.Update(args.ID, args.UpdatePageInput)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	_ = c.store.Notebooks.Touch(p.NotebookID)
	if args.PaperKind != nil || args.PaperSpacing != nil {
		c.emitNotebookChanged(p.NotebookID)
	} else {
		c.emitDataChanged("notebook_page", p.ID)
	}
	return json.Marshal(p)
}

func (c *Core) notebooksPagesReorder(payload []byte) ([]byte, error) {
	var args struct {
		NotebookID string   `json:"notebookId"`
		IDs        []string `json:"ids"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	n, err := c.store.Notebooks.Get(args.NotebookID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	switch n.Binding() {
	case "", domain.BindingRing, domain.BindingCards:
	default:
		return nil, errors.New("only a ring binder or a box of cards can be put in a new order")
	}
	if err := c.store.NotebookPages.Reorder(args.NotebookID, args.IDs); err != nil {
		return nil, err
	}
	c.emitNotebookChanged(args.NotebookID)
	return json.Marshal(map[string]bool{"ok": true})
}

// notebooksPagesDelete tombstones a page and its ink. There is no per-page Trash (the app
// confirms first), and a notebook keeps at least one page.
func (c *Core) notebooksPagesDelete(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	p, n, err := c.writablePage(args.ID)
	if err != nil {
		return nil, err
	}
	if n.Medium() == domain.MediumWax {
		return nil, errWaxLeaves
	}
	pages, err := c.store.NotebookPages.ListForNotebook(p.NotebookID)
	if err != nil {
		return nil, err
	}
	if len(pages) <= 1 {
		return nil, errors.New("a notebook keeps its last page")
	}
	at := 0
	for i, q := range pages {
		if q.ID == p.ID {
			at = i
		}
	}
	s := n.ParsedSettings()
	gone := []*domain.NotebookPage{p}
	switch s.Binding {
	case domain.BindingSewn:
		return nil, errors.New("a sewn journal keeps every page it was sewn with")
	case domain.BindingSpiral, domain.BindingTopbound:
		// Torn out: the pad remembers how many are gone.
		s.Torn++
	case domain.BindingAccordion:
		if at != len(pages)-1 {
			return nil, errors.New("a concertina can only be cut at its end")
		}
	case domain.BindingSaddle:
		// A page comes out with its whole sheet: the four pages folded together.
		if len(pages) <= domain.SaddleSheetPages {
			return nil, errors.New("a stapled notebook keeps its last sheet")
		}
		gone = saddleSheet(pages, at)
	case domain.BindingTravelers:
		if s.Booklets, err = leaveBooklet(s.Booklets, pages, at); err != nil {
			return nil, err
		}
	}
	for _, q := range gone {
		if err := c.store.NotebookInk.DeleteForPage(q.ID); err != nil {
			return nil, err
		}
		if err := c.store.NotebookPages.Delete(q.ID); err != nil {
			return nil, mapStoreErr(err)
		}
	}
	if s.Binding == domain.BindingSpiral || s.Binding == domain.BindingTopbound || s.Binding == domain.BindingTravelers {
		if _, err := c.store.Notebooks.SetCoreSettings(n.ID, s); err != nil {
			return nil, err
		}
	} else {
		_ = c.store.Notebooks.Touch(p.NotebookID)
	}
	c.emitNotebookChanged(p.NotebookID)
	return json.Marshal(map[string]bool{"ok": true})
}

// saddleSheet is the sheet page `at` is printed on: sheet k (from the outside) carries pages
// 2k and 2k+1 before the fold and their mirrors after it.
func saddleSheet(pages []*domain.NotebookPage, at int) []*domain.NotebookPage {
	n := len(pages)
	k := min(at, n-1-at) / 2
	out := []*domain.NotebookPage{}
	for _, i := range []int{2 * k, 2*k + 1, n - 2 - 2*k, n - 1 - 2*k} {
		if i >= 0 && i < n && (len(out) == 0 || out[len(out)-1] != pages[i]) {
			out = append(out, pages[i])
		}
	}
	return out
}

// leaveBooklet takes page `at` out of its booklet in a traveler's notebook. A booklet starting
// on that page now starts on the next one; a booklet keeps its last page.
func leaveBooklet(booklets []domain.Booklet, pages []*domain.NotebookPage, at int) ([]domain.Booklet, error) {
	starts := map[string]int{}
	for i, b := range booklets {
		starts[b.FirstPageID] = i
	}
	i, ok := starts[pages[at].ID]
	if !ok {
		return booklets, nil
	}
	if at+1 >= len(pages) {
		return nil, errors.New("a booklet keeps its last page")
	}
	if _, next := starts[pages[at+1].ID]; next {
		return nil, errors.New("a booklet keeps its last page")
	}
	out := append([]domain.Booklet(nil), booklets...)
	out[i].FirstPageID = pages[at+1].ID
	return out, nil
}

// notebooksPagesMove takes a page out of one ring binder and clips it into another, with its
// ink. Both must be ring binders, and the one it leaves keeps a page.
func (c *Core) notebooksPagesMove(payload []byte) ([]byte, error) {
	var args struct {
		ID         string `json:"id"`
		NotebookID string `json:"notebookId"`
		AfterID    string `json:"afterId"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	p, from, err := c.writablePage(args.ID)
	if err != nil {
		return nil, err
	}
	to, err := c.store.Notebooks.Get(args.NotebookID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	if from.Binding() != domain.BindingRing || to.Binding() != domain.BindingRing {
		return nil, errors.New("pages only move between ring binders")
	}
	if from.ID == to.ID {
		return nil, errors.New("that page is already in this binder")
	}
	pages, err := c.store.NotebookPages.ListForNotebook(from.ID)
	if err != nil {
		return nil, err
	}
	if len(pages) <= 1 {
		return nil, errors.New("a notebook keeps its last page")
	}
	moved, err := c.store.NotebookPages.Move(p.ID, to.ID, args.AfterID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	if err := c.store.NotebookInk.MoveForPage(p.ID, to.ID); err != nil {
		return nil, err
	}
	_ = c.store.Notebooks.Touch(from.ID)
	_ = c.store.Notebooks.Touch(to.ID)
	c.emitNotebookChanged(from.ID)
	c.emitNotebookChanged(to.ID)
	return json.Marshal(moved)
}

// ---- booklets --------------------------------------------------------------------------
// A traveler's notebook's inserts (PLAN-notebooks.md §12). The booklets live in the
// notebook's settings, each starting at a page and running to the next.

func (c *Core) travelersNotebook(id string) (*domain.Notebook, domain.NotebookSettings, error) {
	n, err := c.store.Notebooks.Get(id)
	if err != nil {
		return nil, domain.NotebookSettings{}, mapStoreErr(err)
	}
	s := n.ParsedSettings()
	if s.Binding != domain.BindingTravelers {
		return nil, s, errors.New("only a traveler's notebook holds booklets")
	}
	return n, s, nil
}

// notebooksBookletsAdd slips a new booklet in at the back: one fresh page, on the paper given.
func (c *Core) notebooksBookletsAdd(payload []byte) ([]byte, error) {
	var args struct {
		NotebookID   string `json:"notebookId"`
		Title        string `json:"title"`
		PaperKind    string `json:"paperKind"`
		PaperSpacing int    `json:"paperSpacing"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	n, s, err := c.travelersNotebook(args.NotebookID)
	if err != nil {
		return nil, err
	}
	p, err := c.store.NotebookPages.Add(store.AddPageInput{NotebookID: n.ID, PaperKind: args.PaperKind, PaperSpacing: args.PaperSpacing})
	if err != nil {
		return nil, err
	}
	title := strings.TrimSpace(args.Title)
	if title == "" {
		title = fmt.Sprintf("Booklet %d", len(s.Booklets)+1)
	}
	b := domain.Booklet{ID: newID(), Title: title, FirstPageID: p.ID}
	s.Booklets = append(s.Booklets, b)
	if _, err := c.store.Notebooks.SetCoreSettings(n.ID, s); err != nil {
		return nil, err
	}
	c.emitNotebookChanged(n.ID)
	return json.Marshal(b)
}

// notebooksBookletsUpdate renames a booklet, or slips it out of the cover (archived) and back.
// The cover always holds one booklet.
func (c *Core) notebooksBookletsUpdate(payload []byte) ([]byte, error) {
	var args struct {
		NotebookID string  `json:"notebookId"`
		ID         string  `json:"id"`
		Title      *string `json:"title,omitempty"`
		Archived   *bool   `json:"archived,omitempty"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	n, s, err := c.travelersNotebook(args.NotebookID)
	if err != nil {
		return nil, err
	}
	found := -1
	inCover := 0
	for i, b := range s.Booklets {
		if b.ID == args.ID {
			found = i
		}
		if !b.Archived {
			inCover++
		}
	}
	if found < 0 {
		return nil, mapStoreErr(store.ErrNotFound)
	}
	b := &s.Booklets[found]
	if args.Title != nil && strings.TrimSpace(*args.Title) != "" {
		b.Title = strings.TrimSpace(*args.Title)
	}
	if args.Archived != nil {
		if *args.Archived && !b.Archived && inCover <= 1 {
			return nil, errors.New("a traveler's notebook keeps one booklet in its cover")
		}
		b.Archived = *args.Archived
	}
	if _, err := c.store.Notebooks.SetCoreSettings(n.ID, s); err != nil {
		return nil, err
	}
	c.emitNotebookChanged(n.ID)
	return json.Marshal(*b)
}

// ---- mediums ---------------------------------------------------------------------------
// (PLAN-notebooks.md §11) The rules live here so every device keeps them: a wax codex keeps
// the leaves it was bound with.

var errWaxLeaves = errors.New("a wax codex keeps the leaves it was bound with: smooth a leaf to reuse it")
var errBoundPages = errors.New("this notebook was bound with all its pages: none can be added")

// writablePage loads a page and its notebook.
func (c *Core) writablePage(pageID string) (*domain.NotebookPage, *domain.Notebook, error) {
	p, err := c.store.NotebookPages.Get(pageID)
	if err != nil {
		return nil, nil, mapStoreErr(err)
	}
	n, err := c.store.Notebooks.Get(p.NotebookID)
	if err != nil {
		return nil, nil, mapStoreErr(err)
	}
	return p, n, nil
}

// notebooksPagesSmooth clears a page's text and ink in one step: the flat end of the stylus
// drawn across a wax leaf, or a clay tablet kneaded flat. Any page may be smoothed.
func (c *Core) notebooksPagesSmooth(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	p, _, err := c.writablePage(args.ID)
	if err != nil {
		return nil, err
	}
	empty := ""
	if _, err := c.store.NotebookPages.Update(p.ID, store.UpdatePageInput{ContentMD: &empty}); err != nil {
		return nil, mapStoreErr(err)
	}
	if err := c.store.NotebookInk.DeleteForPage(p.ID); err != nil {
		return nil, err
	}
	_ = c.store.Notebooks.Touch(p.NotebookID)
	c.emitNotebookInkChanged(p.ID)
	c.emitNotebookChanged(p.NotebookID)
	return json.Marshal(map[string]bool{"ok": true})
}

// notebooksPagesSearch finds pages by their text, for the command palette.
func (c *Core) notebooksPagesSearch(payload []byte) ([]byte, error) {
	var args struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	hits, err := c.store.NotebookPages.SearchPages(args.Query, args.Limit)
	if err != nil {
		return nil, err
	}
	return json.Marshal(hits)
}

// ---- ink -------------------------------------------------------------------------------

func (c *Core) notebooksInkList(payload []byte) ([]byte, error) {
	var args struct {
		PageID string `json:"pageId"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.PageID) == "" {
		return nil, errors.New("pageId is required")
	}
	groups, err := c.store.NotebookInk.ListForPage(args.PageID)
	if err != nil {
		return nil, err
	}
	return json.Marshal(groups)
}

func (c *Core) notebooksInkUpsert(payload []byte) ([]byte, error) {
	var args struct {
		PageID string               `json:"pageId"`
		Groups []store.NoteInkInput `json:"groups"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	p, _, err := c.writablePage(args.PageID)
	if err != nil {
		return nil, err
	}
	groups, err := c.store.NotebookInk.UpsertMany(p.NotebookID, p.ID, args.Groups)
	if err != nil {
		return nil, err
	}
	_ = c.store.Notebooks.Touch(p.NotebookID)
	c.emitNotebookInkChanged(p.ID)
	return json.Marshal(groups)
}

func (c *Core) notebooksInkDelete(payload []byte) ([]byte, error) {
	var args struct {
		PageID string   `json:"pageId"`
		IDs    []string `json:"ids"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if _, _, err := c.writablePage(args.PageID); err != nil {
		return nil, err
	}
	n, err := c.store.NotebookInk.DeleteMany(args.IDs)
	if err != nil {
		return nil, err
	}
	c.emitNotebookInkChanged(args.PageID)
	return json.Marshal(map[string]int64{"count": n})
}
