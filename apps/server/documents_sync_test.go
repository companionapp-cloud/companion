package main

import (
	"context"
	"testing"

	"companion/core/store"
)

const docHashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

// A document created on device A converges on device B, and a note that embeds it derives
// the same embed edge on B via sync-apply — proving document metadata sync plus graph
// integration end-to-end (PLAN §6.9, §5.1, §7). The upload-before-push gate is stood in for
// by MarkUploaded (the bridge's blob-upload pass, which precedes the engine push).
func TestDocumentsAndEmbedsSync(t *testing.T) {
	ts := newServer(t)
	token := register(t, ts.URL, "doc@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	doc, err := a.store.Documents.Create(store.CreateDocumentInput{
		Filename: "spec.pdf", Mime: "application/pdf", Size: 4096, SHA256: docHashA,
	})
	if err != nil {
		t.Fatalf("create document: %v", err)
	}
	// Bytes confirmed at the server (blob-upload pass) → the metadata row may now push.
	if err := a.store.Documents.MarkUploaded(doc.ID); err != nil {
		t.Fatalf("mark uploaded: %v", err)
	}
	note, err := a.store.Notes.Create(store.CreateNoteInput{
		Title: "Design", ContentMD: "See ![[doc:" + doc.ID + "]]",
	})
	if err != nil {
		t.Fatalf("create note: %v", err)
	}

	syncAll(t, a, b)

	// B has the document metadata, clean, at a server version.
	gotDoc, err := b.store.Documents.Get(doc.ID)
	if err != nil {
		t.Fatalf("B document = %v", err)
	}
	if gotDoc.Filename != "spec.pdf" || gotDoc.SHA256 != docHashA || gotDoc.Size != 4096 {
		t.Fatalf("B document fields wrong: %+v", gotDoc)
	}
	if gotDoc.Dirty || gotDoc.Version == 0 {
		t.Errorf("synced document should be clean with a server version: %+v", gotDoc)
	}
	// A pulled document is treated as already-uploaded (bytes exist at the server).
	if !gotDoc.BlobUploaded {
		t.Error("B's pulled document should be marked blob-uploaded")
	}

	// B derived the embed edge note→document locally from the synced note body.
	backlinks, err := b.store.Links.Backlinks("document", doc.ID)
	if err != nil {
		t.Fatalf("B backlinks: %v", err)
	}
	if len(backlinks) != 1 || backlinks[0].ID != note.ID {
		t.Fatalf("B did not derive the embed edge note=%s -> doc=%s, got %+v", note.ID, doc.ID, backlinks)
	}
}

// A withheld (un-uploaded) document must not reach the server: the upload-before-push gate
// keeps its metadata local until its bytes are confirmed (PLAN §6.9).
func TestDocumentWithheldUntilUploaded(t *testing.T) {
	ts := newServer(t)
	token := register(t, ts.URL, "hold@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	doc, err := a.store.Documents.Create(store.CreateDocumentInput{
		Filename: "pending.pdf", Size: 10, SHA256: docHashA,
	})
	if err != nil {
		t.Fatalf("create document: %v", err)
	}

	syncAll(t, a, b) // A never marked it uploaded

	if _, err := b.store.Documents.Get(doc.ID); err != store.ErrNotFound {
		t.Errorf("un-uploaded document must not sync to B, got %v", err)
	}

	// Once uploaded, it converges.
	if err := a.store.Documents.MarkUploaded(doc.ID); err != nil {
		t.Fatalf("mark uploaded: %v", err)
	}
	syncAll(t, a, b)
	if _, err := b.store.Documents.Get(doc.ID); err != nil {
		t.Errorf("uploaded document should now reach B, got %v", err)
	}
}

// The server Trash collector tombstones an expired document, and the tombstone pulls down
// to clients as a normal delete (PLAN §4.3, §6.9, §7.6).
func TestDocumentTrashCollectorPurges(t *testing.T) {
	ts, api := newServerAPI(t)
	token := register(t, ts.URL, "trash-doc@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	doc, err := a.store.Documents.Create(store.CreateDocumentInput{Filename: "old.pdf", Size: 1, SHA256: docHashA})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := a.store.Documents.MarkUploaded(doc.ID); err != nil {
		t.Fatalf("mark uploaded: %v", err)
	}
	syncAll(t, a, b)

	// Trash it on A with an already-elapsed deleting_at, then sync so the server sees it.
	a.clk.t = base
	if err := a.store.Documents.Trash(doc.ID); err != nil {
		t.Fatalf("trash: %v", err)
	}
	syncAll(t, a, b)

	// The server's collector promotes the elapsed Trash row to a tombstone.
	if _, err := api.PurgeExpired(); err != nil {
		t.Fatalf("purge expired: %v", err)
	}

	// B pulls the tombstone: gone from the Trash, present as a tombstone.
	syncAll(t, a, b)
	if tr, _ := b.store.Documents.ListTrash(); len(tr) != 0 {
		t.Errorf("B trash after purge = %d, want 0", len(tr))
	}
	gone, err := b.store.Documents.GetAny(doc.ID)
	if err != nil {
		t.Fatalf("B should hold the tombstone row: %v", err)
	}
	if gone.DeletedAt == nil {
		t.Error("B's document should be tombstoned after the collector sweep")
	}
}

// When a purged document was the last row referencing its content hash, the collector GCs
// the bytes from object storage; a shared hash keeps its bytes (PLAN §6.9, §7.6).
func TestDocumentBlobGCOnPurge(t *testing.T) {
	ts, api := newServerAPI(t)
	token := register(t, ts.URL, "gc@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")

	// Two documents (different rows) share the same content hash — one blob, two references.
	content := []byte("pdf")
	sha := sha256Hex(content)
	doc1, _ := a.store.Documents.Create(store.CreateDocumentInput{Filename: "a.pdf", Size: int64(len(content)), SHA256: sha})
	doc2, _ := a.store.Documents.Create(store.CreateDocumentInput{Filename: "a-copy.pdf", Size: int64(len(content)), SHA256: sha})
	a.store.Documents.MarkUploaded(doc1.ID)
	a.store.Documents.MarkUploaded(doc2.ID)

	// Upload the shared bytes for this user, then sync the metadata.
	if status, _ := blobReq(t, "PUT", ts.URL, token, sha, content); status != 200 {
		t.Fatalf("blob upload = %d, want 200", status)
	}
	syncAll(t, a)

	uidStr := userIDForToken(t, api, token)
	key := blobKey(uidStr, sha)

	// Trash + purge doc1: the blob must survive (doc2 still references the hash).
	a.clk.t = base
	a.store.Documents.Trash(doc1.ID)
	syncAll(t, a)
	if _, err := api.PurgeExpired(); err != nil {
		t.Fatalf("purge 1: %v", err)
	}
	if _, err := api.blobs.Get(context.Background(), key); err == errBlobNotFound {
		t.Fatal("blob GC'd while still referenced by doc2")
	}

	// Trash + purge doc2: now the last reference is gone, so the blob is GC'd.
	a.store.Documents.Trash(doc2.ID)
	syncAll(t, a)
	if _, err := api.PurgeExpired(); err != nil {
		t.Fatalf("purge 2: %v", err)
	}
	if _, err := api.blobs.Get(context.Background(), key); err != errBlobNotFound {
		t.Errorf("blob should be GC'd after the last reference is purged, got %v", err)
	}
}

// userIDForToken resolves a session token to its user id (test helper for blob-key checks).
func userIDForToken(t *testing.T, api *Server, token string) string {
	t.Helper()
	var uid string
	if err := api.queryRow(`SELECT user_id FROM sessions WHERE token = ?;`, token).Scan(&uid); err != nil {
		t.Fatalf("resolve uid: %v", err)
	}
	return uid
}
