package bridge

import (
	"encoding/json"
	"testing"

	"companion/core/domain"
)

const bridgeNbInkID = "0190f5a0-0000-7000-8000-0000000000d1"

// A notebook over the bridge (PLAN-notebooks.md): created with a first page, pages added on
// the paper you are on, ink kept through the Trash, everything tombstoned on purge, and none
// of it visible as a note.
func TestNotebooksOverBridge(t *testing.T) {
	c, h := newTestCore(t)
	nb := invoke[domain.Notebook](t, c, "notebooks.create", map[string]string{"title": "Field notes", "coverColor": "forest"})
	if nb.CoverColor != "forest" {
		t.Fatalf("create = %+v", nb)
	}
	doc := invoke[notebookDocument](t, c, "notebooks.get", map[string]string{"id": nb.ID})
	if len(doc.Pages) != 1 || doc.Pages[0].PaperKind != domain.DefaultPaperKind {
		t.Fatalf("a new notebook should open on one default page: %+v", doc.Pages)
	}
	first := doc.Pages[0]

	// The app passes the current page's paper; the new page lands right after it.
	second := invoke[domain.NotebookPage](t, c, "notebooks.pages.add", map[string]any{
		"notebookId": nb.ID, "afterId": first.ID, "paperKind": "dots", "paperSpacing": 24, "contentMd": "",
	})
	third := invoke[domain.NotebookPage](t, c, "notebooks.pages.add", map[string]any{"notebookId": nb.ID, "afterId": first.ID, "paperKind": "grid", "paperSpacing": 32})
	doc = invoke[notebookDocument](t, c, "notebooks.get", map[string]string{"id": nb.ID})
	if len(doc.Pages) != 3 || doc.Pages[0].ID != first.ID || doc.Pages[1].ID != third.ID || doc.Pages[2].ID != second.ID {
		t.Fatalf("page order: %v", []string{doc.Pages[0].ID, doc.Pages[1].ID, doc.Pages[2].ID})
	}
	list := invoke[[]notebookSummary](t, c, "notebooks.list", nil)
	if len(list) != 1 || list[0].PageCount != 3 {
		t.Fatalf("shelf: %+v", list)
	}

	// Text saves emit only a granular data.changed; paper changes refresh the notebook.
	before := h.count(notebooksChangedEvent)
	invoke[domain.NotebookPage](t, c, "notebooks.pages.update", map[string]any{"id": second.ID, "contentMd": "Sourdough starter, day 3"})
	if h.count(notebooksChangedEvent) != before {
		t.Fatal("a text save must not refresh the shelf")
	}
	invoke[domain.NotebookPage](t, c, "notebooks.pages.update", map[string]any{"id": second.ID, "paperKind": "blank"})
	if h.count(notebooksChangedEvent) != before+1 {
		t.Fatal("a paper change should refresh the notebook")
	}

	// Pages are found by text, and never as notes.
	hits := invoke[[]json.RawMessage](t, c, "notebooks.pages.search", map[string]any{"query": "sourdough"})
	if len(hits) != 1 {
		t.Fatalf("search: %s", hits)
	}
	notes := invoke[[]domain.Note](t, c, "notes.list", nil)
	if len(notes) != 0 {
		t.Fatalf("pages leaked into notes: %d", len(notes))
	}

	// Ink on a page, over the bridge, with its own event.
	saved := invoke[[]domain.NotebookPageInk](t, c, "notebooks.ink.upsert", map[string]any{
		"pageId": second.ID,
		"groups": []map[string]any{{"id": bridgeNbInkID, "data": map[string]any{"v": 1, "anchor": map[string]any{"page": true}, "strokes": []any{}}}},
	})
	if len(saved) != 1 || saved[0].NotebookID != nb.ID || saved[0].PageID != second.ID {
		t.Fatalf("ink upsert = %+v", saved)
	}
	if h.count(notebookInkChangedEvent) != 1 {
		t.Fatalf("ink event count %d", h.count(notebookInkChangedEvent))
	}

	// The last page can't be deleted; another one can, taking its ink.
	if _, err := c.Invoke("notebooks.pages.delete", mustJSON(map[string]string{"id": first.ID})); err != nil {
		t.Fatalf("delete page: %v", err)
	}
	invoke[map[string]bool](t, c, "notebooks.pages.delete", map[string]string{"id": third.ID})
	if _, err := c.Invoke("notebooks.pages.delete", mustJSON(map[string]string{"id": second.ID})); err == nil {
		t.Fatal("the last page should be kept")
	}

	// Trash lists the notebook and keeps its pages and ink; purge tombstones all of it.
	invoke[map[string]bool](t, c, "notebooks.delete", map[string]string{"id": nb.ID})
	trash := invoke[[]trashItem](t, c, "trash.list", nil)
	if len(trash) != 1 || trash[0].EntityType != "notebook" || trash[0].Title != "Field notes" {
		t.Fatalf("trash: %+v", trash)
	}
	if got := invoke[[]domain.NotebookPageInk](t, c, "notebooks.ink.list", map[string]string{"pageId": second.ID}); len(got) != 1 {
		t.Fatalf("trash dropped the ink: %+v", got)
	}
	invoke[map[string]bool](t, c, "trash.restore", map[string]string{"entityType": "notebook", "id": nb.ID})
	if list := invoke[[]notebookSummary](t, c, "notebooks.list", nil); len(list) != 1 || list[0].PageCount != 1 {
		t.Fatalf("after restore: %+v", list)
	}
	invoke[map[string]bool](t, c, "notebooks.delete", map[string]string{"id": nb.ID})
	invoke[map[string]bool](t, c, "trash.purge", map[string]string{"entityType": "notebook", "id": nb.ID})
	if got := invoke[[]domain.NotebookPageInk](t, c, "notebooks.ink.list", map[string]string{"pageId": second.ID}); len(got) != 0 {
		t.Fatalf("ink outlived its purged notebook: %+v", got)
	}
	page, err := c.store.NotebookPages.GetAny(second.ID)
	if err != nil || page.DeletedAt == nil || !page.Dirty {
		t.Fatalf("purged page should be a dirty tombstone: %+v (err %v)", page, err)
	}
}
