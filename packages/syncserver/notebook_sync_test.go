package syncserver

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"companion/core/crypto"
	"companion/core/store"
)

const syncNbInk = "0190f5a0-0000-7000-8000-0000000000e1"

// A notebook syncs as three row types (PLAN-notebooks.md): the server holds only ciphertext
// for the title, a page's text and its ink; pages added on two devices both arrive in order;
// and the same page edited on both devices keeps the losing text as the next page.
func TestNotebookSyncPagesInkAndConflictCopy(t *testing.T) {
	ts, srv := newServerAPI(t)
	token := register(t, ts.URL, "nb@b.co", "password")
	cipher := crypto.NewCipher(mustKey(t))
	a := newClient(t, ts.URL, token, "devA")
	a.engine.SetCipher(cipher)
	b := newClient(t, ts.URL, token, "devB")
	b.engine.SetCipher(cipher)

	nb, err := a.store.Notebooks.Create(store.CreateNotebookInput{Title: "Field notes", CoverColor: "forest"})
	if err != nil {
		t.Fatalf("create notebook: %v", err)
	}
	first, err := a.store.NotebookPages.Add(store.AddPageInput{NotebookID: nb.ID, ContentMD: "Sourdough starter, day one"})
	if err != nil {
		t.Fatalf("add page: %v", err)
	}
	if _, err := a.store.NotebookInk.UpsertMany(nb.ID, first.ID, []store.NoteInkInput{
		{ID: syncNbInk, Data: json.RawMessage(`{"v":1,"anchor":{"before":"","after":"","offset":0,"page":true},"strokes":["squiggle"]}`)},
	}); err != nil {
		t.Fatalf("draw: %v", err)
	}
	for _, c := range []*client{a, b} {
		if err := c.engine.Sync(); err != nil {
			t.Fatalf("sync: %v", err)
		}
	}
	gotNb, err := b.store.Notebooks.Get(nb.ID)
	if err != nil || gotNb.Title != "Field notes" || gotNb.CoverColor != "forest" {
		t.Fatalf("B notebook = %+v (err %v)", gotNb, err)
	}
	pages, _ := b.store.NotebookPages.ListForNotebook(nb.ID)
	if len(pages) != 1 || pages[0].ContentMD != "Sourdough starter, day one" {
		t.Fatalf("B pages = %+v", pages)
	}
	ink, _ := b.store.NotebookInk.ListForPage(first.ID)
	if len(ink) != 1 || !strings.Contains(string(ink[0].Data), "squiggle") {
		t.Fatalf("B ink = %+v", ink)
	}

	// The server sees envelopes, not content. Cover colour, paper and order stay readable.
	for _, q := range []struct{ sql, secret string }{
		{`SELECT title FROM notebooks;`, "Field notes"},
		{`SELECT content_md FROM notebook_pages;`, "Sourdough"},
		{`SELECT data_json FROM notebook_page_ink;`, "squiggle"},
	} {
		rows, err := srv.query(q.sql)
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var v string
			rows.Scan(&v)
			if strings.Contains(v, q.secret) || !strings.Contains(v, "enc$v1$") {
				t.Errorf("server can read %q: %s", q.secret, v)
			}
		}
		rows.Close()
	}
	rows, _ := srv.query(`SELECT cover_color FROM notebooks;`)
	rows.Next()
	var color string
	rows.Scan(&color)
	rows.Close()
	if color != "forest" {
		t.Fatalf("cover colour should be plaintext, got %q", color)
	}

	// Each device adds a page after the first; both arrive, and the page order is a total order
	// on every device.
	a.clk.t = base.Add(time.Hour)
	b.clk.t = base.Add(time.Hour)
	if _, err := a.store.NotebookPages.Add(store.AddPageInput{NotebookID: nb.ID, AfterID: first.ID, ContentMD: "from A"}); err != nil {
		t.Fatal(err)
	}
	if _, err := b.store.NotebookPages.Add(store.AddPageInput{NotebookID: nb.ID, AfterID: first.ID, ContentMD: "from B"}); err != nil {
		t.Fatal(err)
	}
	for _, c := range []*client{a, b, a} {
		if err := c.engine.Sync(); err != nil {
			t.Fatalf("sync: %v", err)
		}
	}
	for name, c := range map[string]*client{"A": a, "B": b} {
		pages, _ := c.store.NotebookPages.ListForNotebook(nb.ID)
		if len(pages) != 3 || pages[0].ID != first.ID {
			t.Fatalf("%s: pages = %+v", name, pages)
		}
		for _, p := range pages {
			if p.Dirty {
				t.Fatalf("%s: page still dirty after sync: %+v", name, p)
			}
		}
	}

	// The first page edited on both devices: the newer text wins, the older survives as the
	// page right after it, on the same paper.
	a.clk.t = base.Add(2 * time.Hour)
	b.clk.t = base.Add(3 * time.Hour)
	older := "older text"
	newer := "newer text"
	if _, err := a.store.NotebookPages.Update(first.ID, store.UpdatePageInput{ContentMD: &older}); err != nil {
		t.Fatal(err)
	}
	if _, err := b.store.NotebookPages.Update(first.ID, store.UpdatePageInput{ContentMD: &newer}); err != nil {
		t.Fatal(err)
	}
	// B's newer text lands first; A's push conflicts and forks the copy during that sync, and
	// pushes it on the next one, which B then pulls.
	for _, c := range []*client{b, a, a, b, a} {
		if err := c.engine.Sync(); err != nil {
			t.Fatalf("sync: %v", err)
		}
	}
	for name, c := range map[string]*client{"A": a, "B": b} {
		pages, _ := c.store.NotebookPages.ListForNotebook(nb.ID)
		if len(pages) != 4 {
			t.Fatalf("%s: expected the conflicted copy as a 4th page, got %d", name, len(pages))
		}
		if pages[0].ID != first.ID || pages[0].ContentMD != newer {
			t.Fatalf("%s: first page should carry the newer text: %+v", name, pages[0])
		}
		if !strings.Contains(pages[1].ContentMD, "conflicted copy") || !strings.HasSuffix(pages[1].ContentMD, older) {
			t.Fatalf("%s: the copy should follow the original: %q", name, pages[1].ContentMD)
		}
	}
}

// When a trashed notebook's retention elapses, the server's collector tombstones its pages
// and ink too.
func TestNotebookPurgedWithPagesAndInk(t *testing.T) {
	ts, srv := newServerAPI(t)
	token := register(t, ts.URL, "nbpurge@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	nb, _ := a.store.Notebooks.Create(store.CreateNotebookInput{Title: "Doodles"})
	p, _ := a.store.NotebookPages.Add(store.AddPageInput{NotebookID: nb.ID})
	if _, err := a.store.NotebookInk.UpsertMany(nb.ID, p.ID, []store.NoteInkInput{{ID: syncNbInk, Data: json.RawMessage(`{"v":1}`)}}); err != nil {
		t.Fatal(err)
	}
	if err := a.store.Notebooks.Trash(nb.ID); err != nil {
		t.Fatal(err)
	}
	for _, c := range []*client{a, b} {
		if err := c.engine.Sync(); err != nil {
			t.Fatalf("sync: %v", err)
		}
	}
	if pages, _ := b.store.NotebookPages.ListForNotebook(nb.ID); len(pages) != 1 {
		t.Fatalf("a trashed notebook keeps its pages until purge, B has %d", len(pages))
	}

	srv.clock = &testClock{t: base.Add(store.TrashRetention + time.Hour)}
	if n, err := srv.PurgeExpired(); err != nil || n != 1 {
		t.Fatalf("purge = %d (err %v)", n, err)
	}
	for name, c := range map[string]*client{"A": a, "B": b} {
		if err := c.engine.Sync(); err != nil {
			t.Fatalf("%s sync: %v", name, err)
		}
		if pages, _ := c.store.NotebookPages.ListForNotebook(nb.ID); len(pages) != 0 {
			t.Fatalf("%s: pages should be tombstoned with the notebook, got %d", name, len(pages))
		}
		if ink, _ := c.store.NotebookInk.ListForPage(p.ID); len(ink) != 0 {
			t.Fatalf("%s: ink should be tombstoned with the notebook, got %d", name, len(ink))
		}
	}
}
