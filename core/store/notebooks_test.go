//go:build !js

package store

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"companion/core/domain"
)

func TestNotebookPagesOrderInsertAndDelete(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)
	nb, err := s.Notebooks.Create(CreateNotebookInput{Title: "Field notes", CoverColor: "forest"})
	if err != nil {
		t.Fatalf("create notebook: %v", err)
	}

	// Three pages appended, then one inserted after the first: the later pages shift down and
	// are marked dirty so the order syncs whole.
	var ids []string
	for i, md := range []string{"one", "two", "three"} {
		clk.t = clk.t.Add(time.Minute)
		p, err := s.NotebookPages.Add(AddPageInput{NotebookID: nb.ID, ContentMD: md, PaperKind: "dots", PaperSpacing: 24})
		if err != nil {
			t.Fatalf("add page %d: %v", i, err)
		}
		if p.SortOrder != i {
			t.Fatalf("page %d sort_order = %d", i, p.SortOrder)
		}
		ids = append(ids, p.ID)
	}
	pages, _ := s.NotebookPages.ListForNotebook(nb.ID)
	for _, p := range pages {
		s.NotebookPages.MarkPushed(p.ID, 1)
	}
	inserted, err := s.NotebookPages.Add(AddPageInput{NotebookID: nb.ID, AfterID: ids[0], ContentMD: "one and a half", PaperKind: "dots", PaperSpacing: 24})
	if err != nil {
		t.Fatalf("insert page: %v", err)
	}
	pages, _ = s.NotebookPages.ListForNotebook(nb.ID)
	got := make([]string, 0, len(pages))
	for _, p := range pages {
		got = append(got, p.ContentMD)
	}
	if strings.Join(got, ",") != "one,one and a half,two,three" {
		t.Fatalf("order after insert: %v", got)
	}
	if inserted.SortOrder != 1 || pages[2].SortOrder != 2 || pages[3].SortOrder != 3 {
		t.Fatalf("sort orders: %d %d %d", inserted.SortOrder, pages[2].SortOrder, pages[3].SortOrder)
	}
	if pages[0].Dirty || !pages[2].Dirty || !pages[3].Dirty {
		t.Fatalf("shifted pages should be dirty, unshifted clean: %v %v %v", pages[0].Dirty, pages[2].Dirty, pages[3].Dirty)
	}

	// Default paper when none is given.
	d, _ := s.NotebookPages.Add(AddPageInput{NotebookID: nb.ID})
	if d.PaperKind != domain.DefaultPaperKind || d.PaperSpacing != domain.DefaultPaperSpacing {
		t.Fatalf("default paper: %s/%d", d.PaperKind, d.PaperSpacing)
	}
	if _, err := s.NotebookPages.Add(AddPageInput{NotebookID: nb.ID, PaperKind: "ruled"}); !errors.Is(err, domain.ErrInvalidNotebookPage) {
		t.Fatalf("bad paper should be rejected, got %v", err)
	}

	// Delete tombstones (dirty, so it syncs) and the page leaves the list.
	if err := s.NotebookPages.Delete(inserted.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := s.NotebookPages.Get(inserted.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted page still readable: %v", err)
	}
	any, _ := s.NotebookPages.GetAny(inserted.ID)
	if any.DeletedAt == nil || !any.Dirty {
		t.Fatalf("tombstone should be dirty: %+v", any)
	}
}

func TestNotebookPageConflictedCopyBecomesNextPage(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)
	nb, _ := s.Notebooks.Create(CreateNotebookInput{Title: "Journal"})
	a, _ := s.NotebookPages.Add(AddPageInput{NotebookID: nb.ID, ContentMD: "local edit", PaperKind: "grid", PaperSpacing: 32})
	b, _ := s.NotebookPages.Add(AddPageInput{NotebookID: nb.ID, ContentMD: "later page"})

	server := *a
	server.ContentMD = "server edit"
	if !s.NotebookPages.MeaningfulDiff(a, &server) {
		t.Fatal("different text should be a meaningful diff")
	}
	paper := *a
	paper.PaperKind = "dots"
	if s.NotebookPages.MeaningfulDiff(a, &paper) {
		t.Fatal("a paper change alone should not fork")
	}

	if err := s.NotebookPages.ConflictedCopy(a, "(conflicted copy 2026-09-21)"); err != nil {
		t.Fatalf("conflicted copy: %v", err)
	}
	pages, _ := s.NotebookPages.ListForNotebook(nb.ID)
	if len(pages) != 3 {
		t.Fatalf("expected 3 pages, got %d", len(pages))
	}
	copyPage := pages[1]
	if copyPage.ID == a.ID || copyPage.ID == b.ID {
		t.Fatal("the copy should sit right after the original")
	}
	if !strings.HasPrefix(copyPage.ContentMD, "*conflicted copy 2026-09-21*\n\nlocal edit") {
		t.Fatalf("copy text: %q", copyPage.ContentMD)
	}
	if copyPage.PaperKind != "grid" || copyPage.PaperSpacing != 32 {
		t.Fatalf("copy should keep the paper: %s/%d", copyPage.PaperKind, copyPage.PaperSpacing)
	}
	if pages[2].ID != b.ID || pages[2].SortOrder != 2 {
		t.Fatalf("later page should have shifted: %+v", pages[2])
	}
}

func TestNotebookInkAndPurge(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)
	nb, _ := s.Notebooks.Create(CreateNotebookInput{Title: "Sketches"})
	p, _ := s.NotebookPages.Add(AddPageInput{NotebookID: nb.ID})
	q, _ := s.NotebookPages.Add(AddPageInput{NotebookID: nb.ID})

	groups, err := s.NotebookInk.UpsertMany(nb.ID, p.ID, []NoteInkInput{
		{ID: inkA, Data: json.RawMessage(`{"v":1,"anchor":{"before":"","after":"","offset":0,"page":true},"strokes":[]}`)},
	})
	if err != nil || len(groups) != 1 || groups[0].PageID != p.ID || groups[0].NotebookID != nb.ID {
		t.Fatalf("upsert ink: %v %+v", err, groups)
	}
	// A known group can't be moved to another page by re-upserting it there.
	if _, err := s.NotebookInk.UpsertMany(nb.ID, q.ID, []NoteInkInput{{ID: inkA, Data: json.RawMessage(`{}`)}}); !errors.Is(err, domain.ErrInvalidNotebookPageInk) {
		t.Fatalf("expected rejection, got %v", err)
	}
	if _, err := s.NotebookInk.UpsertMany(nb.ID, q.ID, []NoteInkInput{{ID: inkB, Data: json.RawMessage(`{"v":1}`)}}); err != nil {
		t.Fatalf("upsert ink on q: %v", err)
	}

	// Trash keeps everything; only a purge tombstones pages and ink.
	if err := s.Notebooks.Trash(nb.ID); err != nil {
		t.Fatalf("trash: %v", err)
	}
	if _, err := s.Notebooks.Get(nb.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("trashed notebook should be hidden")
	}
	if live, _ := s.NotebookInk.ListForPage(p.ID); len(live) != 1 {
		t.Fatalf("ink should survive the trash, got %d", len(live))
	}
	if err := s.Notebooks.Restore(nb.ID); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if _, err := s.Notebooks.Get(nb.ID); err != nil {
		t.Fatalf("restored notebook unreadable: %v", err)
	}

	if err := s.NotebookInk.DeleteForNotebook(nb.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.NotebookPages.DeleteForNotebook(nb.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.Notebooks.Delete(nb.ID); err != nil {
		t.Fatal(err)
	}
	if pages, _ := s.NotebookPages.ListForNotebook(nb.ID); len(pages) != 0 {
		t.Fatalf("pages should be gone, got %d", len(pages))
	}
	if ink, _ := s.NotebookInk.ListForPage(q.ID); len(ink) != 0 {
		t.Fatalf("ink should be gone, got %d", len(ink))
	}
	dirtyInk, _ := s.NotebookInk.Dirty()
	if len(dirtyInk) != 2 {
		t.Fatalf("both ink tombstones should be dirty, got %d", len(dirtyInk))
	}
}

func TestNotebookPagesSearchStaysOutOfNotes(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)
	nb, _ := s.Notebooks.Create(CreateNotebookInput{Title: "Field notes"})
	s.NotebookPages.Add(AddPageInput{NotebookID: nb.ID, ContentMD: "first page"})
	s.NotebookPages.Add(AddPageInput{NotebookID: nb.ID, ContentMD: "A recipe for sourdough starter"})
	other, _ := s.Notebooks.Create(CreateNotebookInput{Title: "Trashed"})
	s.NotebookPages.Add(AddPageInput{NotebookID: other.ID, ContentMD: "sourdough in the bin"})
	s.Notebooks.Trash(other.ID)

	hits, err := s.NotebookPages.SearchPages("sourdough starter", 10)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(hits) != 1 {
		t.Fatalf("expected the one live page, got %+v", hits)
	}
	if hits[0].NotebookTitle != "Field notes" || hits[0].PageNumber != 2 || !strings.Contains(hits[0].Snippet, "sourdough") {
		t.Fatalf("hit: %+v", hits[0])
	}
	// Pages are not notes: the notes search and the notes list never see them.
	noteHits, _ := s.Search.Search("sourdough", 10)
	if len(noteHits) != 0 {
		t.Fatalf("notes search must not find pages: %+v", noteHits)
	}
	notes, _ := s.Notes.List()
	if len(notes) != 0 {
		t.Fatalf("pages must not be notes: %d", len(notes))
	}
}
