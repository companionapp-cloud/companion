package bridge

import (
	"encoding/json"
	"errors"
	"strings"

	"companion/core/domain"
	"companion/core/store"
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
	if _, err := c.store.NotebookPages.Add(store.AddPageInput{NotebookID: n.ID}); err != nil {
		return nil, err
	}
	c.emitNotebookChanged(n.ID)
	return json.Marshal(n)
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
	if _, err := c.store.Notebooks.Get(in.NotebookID); err != nil {
		return nil, mapStoreErr(err)
	}
	p, err := c.store.NotebookPages.Add(in)
	if err != nil {
		return nil, err
	}
	_ = c.store.Notebooks.Touch(in.NotebookID)
	c.emitNotebookChanged(in.NotebookID)
	return json.Marshal(p)
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
	p, err := c.store.NotebookPages.Get(args.ID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	pages, err := c.store.NotebookPages.ListForNotebook(p.NotebookID)
	if err != nil {
		return nil, err
	}
	if len(pages) <= 1 {
		return nil, errors.New("a notebook keeps its last page")
	}
	if err := c.store.NotebookInk.DeleteForPage(p.ID); err != nil {
		return nil, err
	}
	if err := c.store.NotebookPages.Delete(p.ID); err != nil {
		return nil, mapStoreErr(err)
	}
	_ = c.store.Notebooks.Touch(p.NotebookID)
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
	p, err := c.store.NotebookPages.Get(args.PageID)
	if err != nil {
		return nil, mapStoreErr(err)
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
	n, err := c.store.NotebookInk.DeleteMany(args.IDs)
	if err != nil {
		return nil, err
	}
	c.emitNotebookInkChanged(args.PageID)
	return json.Marshal(map[string]int64{"count": n})
}
