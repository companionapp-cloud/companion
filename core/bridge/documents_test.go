package bridge

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"companion/core/blob"
	"companion/core/domain"
	"companion/core/store"
)

// hashA is a valid lowercase 64-hex content address for tests that need a document whose
// bytes are not present.
const hashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

// coreWithBlobs builds a test core backed by a filesystem blob store rooted in a temp dir,
// plus that store for direct assertions.
func coreWithBlobs(t *testing.T) (*Core, *blob.FSStore) {
	t.Helper()
	c, _ := newTestCore(t)
	fs, err := blob.NewFSStore(t.TempDir(), nil)
	if err != nil {
		t.Fatalf("new fs store: %v", err)
	}
	c.SetBlobStore(fs)
	return c, fs
}

// documents.ingestFile stages a picked file into a document (the mobile/desktop path):
// the bytes land in the blob store at their content address, and a metadata row is created.
func TestDocumentsIngestFile(t *testing.T) {
	c, fs := coreWithBlobs(t)

	content := []byte("a picked pdf")
	src := filepath.Join(t.TempDir(), "picked.pdf")
	if err := os.WriteFile(src, content, 0o644); err != nil {
		t.Fatalf("write source: %v", err)
	}
	wantSha := sha256Hex(content)

	out, err := c.Invoke("documents.ingestFile", mustJSON(map[string]string{
		"path": src, "filename": "picked.pdf", "mime": "application/pdf",
	}))
	if err != nil {
		t.Fatalf("ingestFile: %v", err)
	}
	var doc domain.Document
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if doc.SHA256 != wantSha || doc.Filename != "picked.pdf" || doc.Size != int64(len(content)) {
		t.Fatalf("unexpected doc: %+v (want sha %s)", doc, wantSha)
	}
	if doc.Mime != "application/pdf" {
		t.Errorf("mime = %q, want application/pdf", doc.Mime)
	}
	// The bytes are in the blob store under the content address.
	if has, _ := fs.Has(wantSha); !has {
		t.Error("ingested bytes not present in the blob store")
	}
	// The document is listed.
	list, err := c.Invoke("documents.list", nil)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	var docs []domain.Document
	json.Unmarshal(list, &docs)
	if len(docs) != 1 || docs[0].ID != doc.ID {
		t.Fatalf("expected the ingested doc in the list, got %+v", docs)
	}
}

// documents.localPath returns the on-disk path for a present document's bytes (what mobile
// reads to build a data URL for the webview).
func TestDocumentsLocalPath(t *testing.T) {
	c, fs := coreWithBlobs(t)

	content := []byte("audio bytes")
	src := filepath.Join(t.TempDir(), "clip.m4a")
	os.WriteFile(src, content, 0o644)
	out, _ := c.Invoke("documents.ingestFile", mustJSON(map[string]string{"path": src, "filename": "clip.m4a", "mime": "audio/mp4"}))
	var doc domain.Document
	json.Unmarshal(out, &doc)

	res, err := c.Invoke("documents.localPath", mustJSON(map[string]string{"id": doc.ID}))
	if err != nil {
		t.Fatalf("localPath: %v", err)
	}
	var got struct {
		Present  bool   `json:"present"`
		Path     string `json:"path"`
		Mime     string `json:"mime"`
		Filename string `json:"filename"`
	}
	json.Unmarshal(res, &got)
	if !got.Present || got.Path != fs.Path(doc.SHA256) {
		t.Fatalf("localPath = %+v, want present at %s", got, fs.Path(doc.SHA256))
	}
	if got.Mime != "audio/mp4" || got.Filename != "clip.m4a" {
		t.Errorf("localPath metadata wrong: %+v", got)
	}
	// The path actually holds the bytes.
	if b, err := os.ReadFile(got.Path); err != nil || string(b) != string(content) {
		t.Errorf("path does not hold the bytes: %v", err)
	}
}

// documents.ingestBytes + documents.dataUrl is the desktop round-trip: the webview hands the
// core base64 bytes, then renders the embed by reading them back as a data URL.
func TestDocumentsIngestBytesAndDataURL(t *testing.T) {
	c, fs := coreWithBlobs(t)

	content := []byte("desktop image bytes")
	b64 := base64.StdEncoding.EncodeToString(content)
	out, err := c.Invoke("documents.ingestBytes", mustJSON(map[string]string{
		"data": b64, "filename": "pic.png", "mime": "image/png",
	}))
	if err != nil {
		t.Fatalf("ingestBytes: %v", err)
	}
	var doc domain.Document
	json.Unmarshal(out, &doc)
	if doc.SHA256 != sha256Hex(content) || doc.Size != int64(len(content)) {
		t.Fatalf("unexpected doc: %+v", doc)
	}
	if has, _ := fs.Has(doc.SHA256); !has {
		t.Fatal("ingested bytes not stored in the blob store")
	}

	res, err := c.Invoke("documents.dataUrl", mustJSON(map[string]string{"id": doc.ID}))
	if err != nil {
		t.Fatalf("dataUrl: %v", err)
	}
	var got struct {
		Present  bool   `json:"present"`
		URL      string `json:"url"`
		Mime     string `json:"mime"`
		Filename string `json:"filename"`
	}
	json.Unmarshal(res, &got)
	want := "data:image/png;base64," + b64
	if !got.Present || got.URL != want {
		t.Fatalf("dataUrl = %+v, want url %s", got, want)
	}
	if got.Mime != "image/png" || got.Filename != "pic.png" {
		t.Errorf("dataUrl metadata wrong: %+v", got)
	}
}

// dataUrl reports not-present (rather than erroring) when a document's bytes aren't local and
// can't be fetched — so the editor shows a graceful fallback instead of a broken render.
func TestDocumentsDataURLAbsent(t *testing.T) {
	c, _ := coreWithBlobs(t)
	// A document whose bytes were never staged (as if synced from elsewhere, not downloaded).
	doc, err := c.store.Documents.Create(store.CreateDocumentInput{Filename: "remote.pdf", Size: 1, SHA256: hashA})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	res, err := c.Invoke("documents.dataUrl", mustJSON(map[string]string{"id": doc.ID}))
	if err != nil {
		t.Fatalf("dataUrl: %v", err)
	}
	var got struct {
		Present bool `json:"present"`
	}
	json.Unmarshal(res, &got)
	if got.Present {
		t.Error("expected present:false for a document with no local bytes and no server")
	}
}

// Without a filesystem-capable blob store (e.g. the web OPFS store, or none injected), the
// path-based methods report a clear error rather than misbehaving.
func TestDocumentsIngestFileNoLocalStore(t *testing.T) {
	c, _ := newTestCore(t) // no blob store injected
	if _, err := c.Invoke("documents.ingestFile", mustJSON(map[string]string{"path": "/x", "filename": "x"})); err == nil {
		t.Error("expected an error when no local blob store is available")
	}
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
