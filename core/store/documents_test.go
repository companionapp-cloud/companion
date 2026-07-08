//go:build !js

package store

import (
	"testing"
	"time"

	"companion/core/domain"
)

// hashA/hashB are valid lowercase 64-hex content addresses for tests.
const (
	hashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	hashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func newTestDoc(t *testing.T, s *Store, filename, sha string) string {
	t.Helper()
	d, err := s.Documents.Create(CreateDocumentInput{Filename: filename, Mime: "application/pdf", Size: 1024, SHA256: sha})
	if err != nil {
		t.Fatalf("create document: %v", err)
	}
	return d.ID
}

func TestDocumentCreateAndGet(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 8, 9, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	id := newTestDoc(t, s, "report.pdf", hashA)
	d, err := s.Documents.Get(id)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if d.Filename != "report.pdf" || d.SHA256 != hashA || d.Size != 1024 {
		t.Errorf("unexpected doc: %+v", d)
	}
	if !d.Dirty || d.Version != 0 {
		t.Errorf("new doc should be dirty at version 0: %+v", d)
	}
	if d.BlobUploaded {
		t.Error("new doc should not be marked blob-uploaded")
	}
}

func TestDocumentCreateRejectsBadHash(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 8, 9, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)
	if _, err := s.Documents.Create(CreateDocumentInput{Filename: "x", SHA256: "not-a-hash"}); err == nil {
		t.Error("expected create to reject a malformed sha256")
	}
	if _, err := s.Documents.Create(CreateDocumentInput{Filename: "", SHA256: hashA}); err == nil {
		t.Error("expected create to reject an empty filename")
	}
}

// TestDocumentDefaultMime confirms an empty mime falls back to octet-stream.
func TestDocumentDefaultMime(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 8, 9, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)
	d, err := s.Documents.Create(CreateDocumentInput{Filename: "a.bin", SHA256: hashA})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if d.Mime != "application/octet-stream" {
		t.Errorf("mime = %q, want octet-stream default", d.Mime)
	}
}

// TestDocumentDirtyGatedByUpload is the upload-before-push guarantee (PLAN §6.9): a live,
// dirty document is withheld from the sync push until its bytes are confirmed uploaded.
func TestDocumentDirtyGatedByUpload(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 8, 9, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	id := newTestDoc(t, s, "audio.m4a", hashA)

	dirty, err := s.Documents.Dirty()
	if err != nil {
		t.Fatalf("dirty: %v", err)
	}
	if len(dirty) != 0 {
		t.Fatalf("un-uploaded doc must be withheld from push, got %d rows", len(dirty))
	}

	pending, err := s.Documents.PendingUpload()
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	if len(pending) != 1 || pending[0].ID != id {
		t.Fatalf("expected the doc to be pending upload, got %+v", pending)
	}

	if err := s.Documents.MarkUploaded(id); err != nil {
		t.Fatalf("mark uploaded: %v", err)
	}
	dirty, err = s.Documents.Dirty()
	if err != nil {
		t.Fatalf("dirty: %v", err)
	}
	if len(dirty) != 1 || dirty[0].ID != id {
		t.Fatalf("uploaded doc should now be pushable, got %+v", dirty)
	}
}

// TestDocumentTombstonePushableWithoutUpload confirms a deletion pushes even if the bytes
// were never uploaded — a tombstone needs no blob.
func TestDocumentTombstonePushableWithoutUpload(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 8, 9, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	id := newTestDoc(t, s, "temp.txt", hashA) // never uploaded
	if err := s.Documents.Delete(id); err != nil {
		t.Fatalf("delete: %v", err)
	}
	dirty, err := s.Documents.Dirty()
	if err != nil {
		t.Fatalf("dirty: %v", err)
	}
	if len(dirty) != 1 || dirty[0].DeletedAt == nil {
		t.Fatalf("tombstone should be pushable without upload, got %+v", dirty)
	}
}

func TestDocumentTrashLifecycle(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 8, 9, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	id := newTestDoc(t, s, "slides.key", hashA)

	if err := s.Documents.Trash(id); err != nil {
		t.Fatalf("trash: %v", err)
	}
	if _, err := s.Documents.Get(id); err != ErrNotFound {
		t.Errorf("trashed doc should be hidden from Get, got %v", err)
	}
	list, err := s.Documents.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 0 {
		t.Errorf("trashed doc should be hidden from List, got %d", len(list))
	}
	trash, err := s.Documents.ListTrash()
	if err != nil {
		t.Fatalf("list trash: %v", err)
	}
	if len(trash) != 1 || trash[0].ID != id {
		t.Fatalf("expected the doc in trash, got %+v", trash)
	}

	if err := s.Documents.Restore(id); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if _, err := s.Documents.Get(id); err != nil {
		t.Errorf("restored doc should be visible again, got %v", err)
	}
}

func TestDocumentRename(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 8, 9, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	id := newTestDoc(t, s, "old.pdf", hashA)
	if err := s.Documents.MarkUploaded(id); err != nil {
		t.Fatalf("mark uploaded: %v", err)
	}
	d, err := s.Documents.Rename(id, "new.pdf")
	if err != nil {
		t.Fatalf("rename: %v", err)
	}
	if d.Filename != "new.pdf" {
		t.Errorf("filename = %q, want new.pdf", d.Filename)
	}
	// A rename must not re-open the upload gate: bytes are unchanged (same hash).
	if !d.BlobUploaded {
		t.Error("rename should preserve blob_uploaded (hash unchanged)")
	}
}

// TestDocumentHashReferencedElsewhere backs blob GC: bytes are only deletable when no other
// live row shares the content hash (PLAN §6.9 dedupe).
func TestDocumentHashReferencedElsewhere(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 8, 9, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	id1 := newTestDoc(t, s, "a.pdf", hashA)
	id2 := newTestDoc(t, s, "a-copy.pdf", hashA) // same bytes, different row
	idOther := newTestDoc(t, s, "b.pdf", hashB)

	ref, err := s.Documents.HashReferencedElsewhere(hashA, id1)
	if err != nil {
		t.Fatalf("ref check: %v", err)
	}
	if !ref {
		t.Error("hashA is still referenced by id2, must report referenced")
	}

	// Tombstone the duplicate; now hashA is referenced only by id1.
	if err := s.Documents.Delete(id2); err != nil {
		t.Fatalf("delete dup: %v", err)
	}
	ref, err = s.Documents.HashReferencedElsewhere(hashA, id1)
	if err != nil {
		t.Fatalf("ref check: %v", err)
	}
	if ref {
		t.Error("hashA should no longer be referenced elsewhere after the dup is tombstoned")
	}

	refOther, err := s.Documents.HashReferencedElsewhere(hashB, idOther)
	if err != nil {
		t.Fatalf("ref check: %v", err)
	}
	if refOther {
		t.Error("hashB is unique to idOther, must report not referenced elsewhere")
	}
}

// TestDocumentIsGraphNode confirms a live document projects into graph_nodes (so notes can
// embed it) and drops out when trashed.
func TestDocumentIsGraphNode(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 8, 9, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	id := newTestDoc(t, s, "diagram.png", hashA)
	node, err := s.Links.LookupNode(id)
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if node == nil || node.Type != "document" || node.Title != "diagram.png" {
		t.Fatalf("expected a document graph node, got %+v", node)
	}

	if err := s.Documents.Trash(id); err != nil {
		t.Fatalf("trash: %v", err)
	}
	node, err = s.Links.LookupNode(id)
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if node != nil {
		t.Error("trashed document should not project as a graph node")
	}
}

// TestNoteEmbedsDocumentEdge is the graph integration: a note embedding ![[doc:<id>]]
// derives an 'embed' edge to the document node, on the ordinary write path.
func TestNoteEmbedsDocumentEdge(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 8, 9, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	docID := newTestDoc(t, s, "spec.pdf", hashA)
	note, err := s.Notes.Create(CreateNoteInput{Title: "Design", ContentMD: "See ![[doc:" + docID + "]]"})
	if err != nil {
		t.Fatalf("create note: %v", err)
	}

	backlinks, err := s.Links.Backlinks("document", docID)
	if err != nil {
		t.Fatalf("backlinks: %v", err)
	}
	if len(backlinks) != 1 || backlinks[0].ID != note.ID {
		t.Fatalf("expected the note to back-link the document, got %+v", backlinks)
	}

	g, err := s.Links.Full()
	if err != nil {
		t.Fatalf("full graph: %v", err)
	}
	found := false
	for _, e := range g.Edges {
		if e.SourceID == note.ID && e.TargetType == "document" && e.TargetID == docID && e.Kind == "embed" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected an embed edge note→document, edges: %+v", g.Edges)
	}
}

// TestDocumentApplyClearsUploadGate confirms a synced-in document is treated as
// already-uploaded (its bytes exist at the server), so it is not re-queued for upload.
func TestDocumentApplyClearsUploadGate(t *testing.T) {
	clk := &fixedClock{t: time.Date(2026, 7, 8, 9, 0, 0, 0, time.UTC)}
	s := newTestStore(t, clk)

	now := clk.t
	incoming := &domain.Document{
		ID: "01916f00-0000-7000-8000-000000000abc", Filename: "server.pdf",
		Mime: "application/pdf", Size: 2048, SHA256: hashA,
		CreatedAt: now, UpdatedAt: now, Version: 3,
	}
	if err := s.Documents.Apply(incoming); err != nil {
		t.Fatalf("apply: %v", err)
	}
	got, err := s.Documents.Get(incoming.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !got.BlobUploaded {
		t.Error("pulled document should be marked blob-uploaded (bytes exist at server)")
	}
	if got.Dirty {
		t.Error("pulled document should not be dirty")
	}
	if got.Version != 3 {
		t.Errorf("version = %d, want 3 (server-canonical)", got.Version)
	}
	pending, err := s.Documents.PendingUpload()
	if err != nil {
		t.Fatalf("pending: %v", err)
	}
	for _, p := range pending {
		if p.ID == incoming.ID {
			t.Error("pulled document must not be queued for upload")
		}
	}
}
