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

// The ancient mediums (PLAN-notebooks.md §11): a fired clay tablet is fixed for good, a wax
// codex keeps the leaves it was bound with and is reused by smoothing, and the medium itself
// survives settings saves (the guides) untouched.
func TestNotebookMediumsOverBridge(t *testing.T) {
	c, _ := newTestCore(t)
	fails := func(method string, args any) {
		t.Helper()
		payload, _ := json.Marshal(args)
		if _, err := c.Invoke(method, payload); err == nil {
			t.Fatalf("%s should have been refused", method)
		}
	}

	// Saving the guides keeps the medium; an update can't change it.
	clay := invoke[domain.Notebook](t, c, "notebooks.create", map[string]any{"title": "Accounts", "medium": "clay"})
	invoke[domain.Notebook](t, c, "notebooks.update", map[string]any{"id": clay.ID, "settingsJson": map[string]any{"guides": []any{}, "medium": "paper"}})
	got := invoke[notebookDocument](t, c, "notebooks.get", map[string]string{"id": clay.ID}).Notebook
	if got.Medium() != domain.MediumClay {
		t.Fatalf("settings save clobbered the medium: %s", got.Settings)
	}

	// Wax: bound with its leaves, none added or removed; smoothing clears a leaf.
	wax := invoke[domain.Notebook](t, c, "notebooks.create", map[string]any{"title": "Drafts", "medium": "wax", "leaves": 3})
	doc := invoke[notebookDocument](t, c, "notebooks.get", map[string]string{"id": wax.ID})
	if len(doc.Pages) != 3 {
		t.Fatalf("a triptych has 3 leaves, got %d", len(doc.Pages))
	}
	leaf := doc.Pages[1]
	fails("notebooks.pages.add", map[string]any{"notebookId": wax.ID})
	fails("notebooks.pages.delete", map[string]string{"id": leaf.ID})
	invoke[domain.NotebookPage](t, c, "notebooks.pages.update", map[string]any{"id": leaf.ID, "contentMd": "Arma virumque cano"})
	invoke[[]domain.NotebookPageInk](t, c, "notebooks.ink.upsert", map[string]any{"pageId": leaf.ID, "groups": []map[string]any{{"id": bridgeNbInkID, "data": map[string]any{"strokes": []any{}}}}})
	invoke[map[string]bool](t, c, "notebooks.pages.smooth", map[string]string{"id": leaf.ID})
	if p := invoke[domain.NotebookPage](t, c, "notebooks.pages.get", map[string]string{"id": leaf.ID}); p.ContentMD != "" {
		t.Fatalf("smoothed leaf kept %q", p.ContentMD)
	}
	if ink := invoke[[]domain.NotebookPageInk](t, c, "notebooks.ink.list", map[string]string{"pageId": leaf.ID}); len(ink) != 0 {
		t.Fatalf("smoothed leaf kept %d ink groups", len(ink))
	}

	// The first sherd is picked from the heap when the notebook is made.
	const first = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
	heap := invoke[domain.Notebook](t, c, "notebooks.create", map[string]any{"medium": "sherd", "firstPageId": first})
	if got := invoke[notebookDocument](t, c, "notebooks.get", map[string]string{"id": heap.ID}).Pages; len(got) != 1 || got[0].ID != first {
		t.Fatalf("first sherd = %+v, want %s", got, first)
	}

	// The app may choose a page's id (a sherd picked from the heap); a reused id is refused.
	const picked = "5b3e2c1a-8f4d-4e6a-9b7c-1d2e3f4a5b6c"
	p := invoke[domain.NotebookPage](t, c, "notebooks.pages.add", map[string]any{"notebookId": heap.ID, "id": picked})
	if p.ID != picked {
		t.Fatalf("page id = %s, want the one picked", p.ID)
	}
	fails("notebooks.pages.add", map[string]any{"notebookId": heap.ID, "id": picked})
	fails("notebooks.pages.add", map[string]any{"notebookId": heap.ID, "id": "not-a-uuid"})

	// Bad bindings and unknown mediums are refused.
	fails("notebooks.create", map[string]any{"medium": "wax", "leaves": 5})
	fails("notebooks.create", map[string]any{"medium": "papyrus"})
}

// Bindings (PLAN-notebooks.md §12): each binding's physical rules, kept by the core.
func TestNotebookBindingsOverBridge(t *testing.T) {
	c, _ := newTestCore(t)
	fails := func(method string, args any) {
		t.Helper()
		payload, _ := json.Marshal(args)
		if _, err := c.Invoke(method, payload); err == nil {
			t.Fatalf("%s %v should have been refused", method, args)
		}
	}
	pagesOf := func(id string) []*domain.NotebookPage {
		t.Helper()
		return invoke[notebookDocument](t, c, "notebooks.get", map[string]string{"id": id}).Pages
	}
	ids := func(pages []*domain.NotebookPage) []string {
		out := make([]string, len(pages))
		for i, p := range pages {
			out[i] = p.ID
		}
		return out
	}
	make := func(args map[string]any) domain.Notebook {
		t.Helper()
		return invoke[domain.Notebook](t, c, "notebooks.create", args)
	}

	// A notebook made without a binding keeps the old rules, and the binding survives saves.
	plain := make(map[string]any{"title": "Plain"})
	if plain.Binding() != "" {
		t.Fatalf("plain binding = %q", plain.Binding())
	}

	// Sewn: every page from the start, none added, removed or reordered.
	sewn := make(map[string]any{"binding": "sewn", "pages": 48})
	sp := pagesOf(sewn.ID)
	if len(sp) != 48 {
		t.Fatalf("sewn pages = %d", len(sp))
	}
	invoke[domain.Notebook](t, c, "notebooks.update", map[string]any{"id": sewn.ID, "settingsJson": map[string]any{"binding": "ring", "ribbon": sp[3].ID}})
	if got := invoke[notebookDocument](t, c, "notebooks.get", map[string]string{"id": sewn.ID}).Notebook; got.Binding() != "sewn" {
		t.Fatalf("settings save clobbered the binding: %s", got.Settings)
	}
	fails("notebooks.pages.add", map[string]any{"notebookId": sewn.ID})
	fails("notebooks.pages.delete", map[string]string{"id": sp[0].ID})
	fails("notebooks.pages.reorder", map[string]any{"notebookId": sewn.ID, "ids": []string{sp[1].ID, sp[0].ID}})
	if d := make(map[string]any{"binding": "sewn"}); len(pagesOf(d.ID)) != 96 {
		t.Fatal("a sewn journal defaults to 96 pages")
	}

	// Spiral and top-bound pads: torn out, counted, never added.
	for _, b := range []string{"spiral", "topbound"} {
		pad := make(map[string]any{"binding": b, "pages": 40})
		pp := pagesOf(pad.ID)
		fails("notebooks.pages.add", map[string]any{"notebookId": pad.ID})
		invoke[map[string]bool](t, c, "notebooks.pages.delete", map[string]string{"id": pp[5].ID})
		invoke[map[string]bool](t, c, "notebooks.pages.delete", map[string]string{"id": pp[6].ID})
		got := invoke[notebookDocument](t, c, "notebooks.get", map[string]string{"id": pad.ID})
		if len(got.Pages) != 38 || got.Notebook.ParsedSettings().Torn != 2 {
			t.Fatalf("%s after two tears: %d pages, torn %d", b, len(got.Pages), got.Notebook.ParsedSettings().Torn)
		}
	}

	// Ring binders: pages go in anywhere, reorder, and move to another binder with their ink.
	ring := make(map[string]any{"binding": "ring"})
	other := make(map[string]any{"binding": "ring"})
	r0 := pagesOf(ring.ID)[0]
	r1 := invoke[domain.NotebookPage](t, c, "notebooks.pages.add", map[string]any{"notebookId": ring.ID, "afterId": r0.ID})
	invoke[map[string]bool](t, c, "notebooks.pages.reorder", map[string]any{"notebookId": ring.ID, "ids": []string{r1.ID, r0.ID}})
	if got := ids(pagesOf(ring.ID)); got[0] != r1.ID {
		t.Fatalf("ring reorder = %v", got)
	}
	invoke[[]domain.NotebookPageInk](t, c, "notebooks.ink.upsert", map[string]any{"pageId": r1.ID, "groups": []map[string]any{{"id": bridgeNbInkID, "data": map[string]any{"strokes": []any{}}}}})
	o0 := pagesOf(other.ID)[0]
	moved := invoke[domain.NotebookPage](t, c, "notebooks.pages.move", map[string]any{"id": r1.ID, "notebookId": other.ID, "afterId": o0.ID})
	if moved.NotebookID != other.ID {
		t.Fatalf("moved page = %+v", moved)
	}
	if got := ids(pagesOf(other.ID)); len(got) != 2 || got[1] != r1.ID {
		t.Fatalf("binder after move = %v", got)
	}
	if got := ids(pagesOf(ring.ID)); len(got) != 1 || got[0] != r0.ID {
		t.Fatalf("binder left = %v", got)
	}
	if ink, _ := c.store.NotebookInk.GetAny(bridgeNbInkID); ink.NotebookID != other.ID {
		t.Fatalf("ink stayed in the old binder: %+v", ink)
	}
	fails("notebooks.pages.move", map[string]any{"id": r0.ID, "notebookId": other.ID}) // its last page
	fails("notebooks.pages.move", map[string]any{"id": o0.ID, "notebookId": plain.ID})  // not a binder

	// Stapled: sheets of four at the centre fold, taken out whole, 48 pages at most.
	saddle := make(map[string]any{"binding": "saddle", "pages": 16})
	s0 := ids(pagesOf(saddle.ID))
	sheet := invoke[domain.NotebookPage](t, c, "notebooks.pages.add", map[string]any{"notebookId": saddle.ID, "afterId": s0[0]})
	s1 := ids(pagesOf(saddle.ID))
	if len(s1) != 20 || s1[8] != sheet.ID || s1[7] != s0[7] || s1[12] != s0[8] {
		t.Fatalf("a new sheet should fold in at the centre: %v", s1)
	}
	// Page 2 (index 1) is on the outer sheet with pages 1, 19 and 20.
	invoke[map[string]bool](t, c, "notebooks.pages.delete", map[string]string{"id": s1[1]})
	s2 := ids(pagesOf(saddle.ID))
	if len(s2) != 16 || s2[0] != s1[2] || s2[15] != s1[17] {
		t.Fatalf("taking out the outer sheet: %v", s2)
	}
	for range 8 {
		invoke[domain.NotebookPage](t, c, "notebooks.pages.add", map[string]any{"notebookId": saddle.ID})
	}
	fails("notebooks.pages.add", map[string]any{"notebookId": saddle.ID})

	// Cards: in anywhere, shuffled.
	cards := make(map[string]any{"binding": "cards"})
	c0 := pagesOf(cards.ID)[0]
	if c0.PaperKind != domain.PaperLined || c0.PaperSpacing != 24 {
		t.Fatalf("an index card is narrow-lined: %+v", c0)
	}
	c1 := invoke[domain.NotebookPage](t, c, "notebooks.pages.add", map[string]any{"notebookId": cards.ID, "afterId": c0.ID})
	invoke[map[string]bool](t, c, "notebooks.pages.reorder", map[string]any{"notebookId": cards.ID, "ids": []string{c1.ID, c0.ID}})

	// Concertina: panels added and cut at the end only.
	acc := make(map[string]any{"binding": "accordion"})
	a0 := pagesOf(acc.ID)[0]
	a1 := invoke[domain.NotebookPage](t, c, "notebooks.pages.add", map[string]any{"notebookId": acc.ID})
	a2 := invoke[domain.NotebookPage](t, c, "notebooks.pages.add", map[string]any{"notebookId": acc.ID, "afterId": a0.ID})
	if got := ids(pagesOf(acc.ID)); got[1] != a1.ID || got[2] != a2.ID {
		t.Fatalf("a concertina grows at its end: %v", got)
	}
	fails("notebooks.pages.delete", map[string]string{"id": a1.ID})
	invoke[map[string]bool](t, c, "notebooks.pages.delete", map[string]string{"id": a2.ID})
	fails("notebooks.pages.reorder", map[string]any{"notebookId": acc.ID, "ids": []string{a1.ID, a0.ID}})

	// Traveler's notebook: booklets, each a run of pages, slipped out and back.
	tn := make(map[string]any{"binding": "travelers"})
	bs := tn.ParsedSettings().Booklets
	t0 := pagesOf(tn.ID)[0]
	if len(bs) != 1 || bs[0].FirstPageID != t0.ID {
		t.Fatalf("a traveler's notebook starts with one booklet: %+v", bs)
	}
	b2 := invoke[domain.Booklet](t, c, "notebooks.booklets.add", map[string]any{"notebookId": tn.ID, "title": "Kyoto"})
	t1 := invoke[domain.NotebookPage](t, c, "notebooks.pages.add", map[string]any{"notebookId": tn.ID, "afterId": t0.ID})
	if got := ids(pagesOf(tn.ID)); got[1] != t1.ID || got[2] != b2.FirstPageID {
		t.Fatalf("a page added in the first booklet stays in it: %v", got)
	}
	// Deleting a booklet's first page moves its start on; its last page stays.
	invoke[map[string]bool](t, c, "notebooks.pages.delete", map[string]string{"id": t0.ID})
	bs = invoke[notebookDocument](t, c, "notebooks.get", map[string]string{"id": tn.ID}).Notebook.ParsedSettings().Booklets
	if bs[0].FirstPageID != t1.ID {
		t.Fatalf("booklet start after delete = %+v", bs[0])
	}
	fails("notebooks.pages.delete", map[string]string{"id": t1.ID})
	fails("notebooks.pages.delete", map[string]string{"id": b2.FirstPageID})
	invoke[domain.Booklet](t, c, "notebooks.booklets.update", map[string]any{"notebookId": tn.ID, "id": b2.ID, "archived": true, "title": "Kyoto 2026"})
	fails("notebooks.booklets.update", map[string]any{"notebookId": tn.ID, "id": bs[0].ID, "archived": true})
	fails("notebooks.booklets.add", map[string]any{"notebookId": ring.ID})

	// Bad bindings are refused.
	fails("notebooks.create", map[string]any{"binding": "perfect"})
	fails("notebooks.create", map[string]any{"binding": "sewn", "pages": 50})
	fails("notebooks.create", map[string]any{"medium": "clay", "binding": "ring"})
}
