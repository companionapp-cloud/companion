package bridge

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"

	"companion/core/blob"
	"companion/core/store"
)

// errNoLocalBlobStore is returned when a path-based document operation is attempted on a
// platform whose blob store doesn't expose local filesystem access (i.e. the web/OPFS
// store). Desktop and mobile inject a filesystem store that does (PLAN §6.9).
var errNoLocalBlobStore = errors.New("blob store does not support local file access")

// Documents are file embeds in notes (PLAN §6.9): metadata rows that sync while their bytes
// live in the platform BlobStore. Ingestion and rendering are shell-side operations against
// that store — the shell stages the bytes, computes the sha256, then calls documents.create
// with metadata only; to render, it ensures the bytes are local (documents.ensureLocal) and
// resolves a platform URL from its own store impl. Raw bytes never cross this bridge.

// documentsChangedEvent lets document lists refresh; data.changed refreshes the graph and
// any note NodeViews that embed a document (PLAN §6.9, §5.4).
const documentsChangedEvent = "documents.changed"

func (c *Core) emitDocumentChanged(id string) {
	c.emit(documentsChangedEvent, nil)
	c.emitDataChanged("document", id)
}

func (c *Core) documentsList() ([]byte, error) {
	docs, err := c.store.Documents.List()
	if err != nil {
		return nil, err
	}
	return json.Marshal(docs)
}

func (c *Core) documentsGet(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	d, err := c.store.Documents.Get(args.ID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	return json.Marshal(d)
}

// documentsCreate records a new document. The shell has already staged the bytes into the
// blob store and computed sha256/size; this only writes the metadata row (PLAN §6.9). The
// bytes upload before the row is pushed on the next sync (upload-before-push).
func (c *Core) documentsCreate(payload []byte) ([]byte, error) {
	var in store.CreateDocumentInput
	if err := unmarshal(payload, &in); err != nil {
		return nil, err
	}
	d, err := c.store.Documents.Create(in)
	if err != nil {
		return nil, err
	}
	c.emitDocumentChanged(d.ID)
	return json.Marshal(d)
}

// documentsRename changes a document's display filename (its only mutable field; bytes are
// immutable).
func (c *Core) documentsRename(payload []byte) ([]byte, error) {
	var args struct {
		ID       string `json:"id"`
		Filename string `json:"filename"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	d, err := c.store.Documents.Rename(args.ID, args.Filename)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitDocumentChanged(d.ID)
	return json.Marshal(d)
}

// documentsDelete moves a document to the Trash (PLAN §4.3), like notes.delete and
// tasks.delete. "Delete forever" and "Restore" go through the trash.* methods, which also
// GC the local bytes once no live row references the hash.
func (c *Core) documentsDelete(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if err := c.store.Documents.Trash(args.ID); err != nil {
		return nil, mapStoreErr(err)
	}
	c.emitDocumentChanged(args.ID)
	return json.Marshal(map[string]bool{"ok": true})
}

// documentsIngestFile stages a file at a native filesystem path (from an OS file picker) into
// a document and records the metadata row (PLAN §6.9) — the mobile/desktop counterpart to the
// web shell's blob-store put(). The bytes are hashed and stored by the injected filesystem
// blob store; only the metadata row is created here. Bytes upload on the next sync.
func (c *Core) documentsIngestFile(payload []byte) ([]byte, error) {
	var args struct {
		Path     string `json:"path"`
		Filename string `json:"filename"`
		Mime     string `json:"mime"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	local, ok := c.blobs.(blob.LocalStore)
	if !ok {
		return nil, errNoLocalBlobStore
	}
	sha, size, err := local.IngestPath(args.Path)
	if err != nil {
		return nil, err
	}
	filename := args.Filename
	if filename == "" {
		filename = "file"
	}
	doc, err := c.store.Documents.Create(store.CreateDocumentInput{
		Filename: filename, Mime: args.Mime, Size: size, SHA256: sha,
	})
	if err != nil {
		return nil, err
	}
	c.emitDocumentChanged(doc.ID)
	return json.Marshal(doc)
}

// documentsIngestBytes stages base64-encoded bytes into a document (the desktop path): the
// webview reads a picked/dropped file and hands its bytes to the core over the invoke bridge,
// where they're hashed and stored by the filesystem blob store (PLAN §6.9). Used where the
// shell has the bytes in hand but no filesystem path (a browser File) and can't reach the
// blob store directly.
func (c *Core) documentsIngestBytes(payload []byte) ([]byte, error) {
	var args struct {
		Data     string `json:"data"` // base64
		Filename string `json:"filename"`
		Mime     string `json:"mime"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	local, ok := c.blobs.(blob.LocalStore)
	if !ok {
		return nil, errNoLocalBlobStore
	}
	raw, err := base64.StdEncoding.DecodeString(args.Data)
	if err != nil {
		return nil, errors.Join(errors.New("decode blob data"), err)
	}
	sha, size, err := local.Put(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	filename := args.Filename
	if filename == "" {
		filename = "file"
	}
	doc, err := c.store.Documents.Create(store.CreateDocumentInput{
		Filename: filename, Mime: args.Mime, Size: size, SHA256: sha,
	})
	if err != nil {
		return nil, err
	}
	c.emitDocumentChanged(doc.ID)
	return json.Marshal(doc)
}

// documentsDataURL ensures a document's bytes are present (downloading lazily) and returns
// them as a base64 data URL for a webview that can't reach the filesystem (desktop) — the
// counterpart to the web OPFS store's objectUrl and mobile's localPath+read (PLAN §6.9).
// Returns {present:false} when the bytes aren't available.
func (c *Core) documentsDataURL(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	d, err := c.store.Documents.Get(args.ID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	local, ok := c.blobs.(blob.LocalStore)
	if !ok {
		return nil, errNoLocalBlobStore
	}
	present, err := c.ensureLocalBytes(d.SHA256)
	if err != nil {
		return nil, err
	}
	if !present {
		return json.Marshal(map[string]any{"present": false})
	}
	rc, err := local.Open(d.SHA256)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	raw, err := io.ReadAll(rc)
	if err != nil {
		return nil, err
	}
	mime := d.Mime
	if mime == "" {
		mime = "application/octet-stream"
	}
	url := "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(raw)
	return json.Marshal(map[string]any{"present": true, "url": url, "mime": mime, "filename": d.Filename})
}

// documentsLocalPath ensures a document's bytes are present locally (downloading lazily) and
// returns their absolute filesystem path, for a shell that renders from a file rather than a
// URL (mobile reads the path and hands the webview a data URL). Returns {present, path}. Only
// works with a filesystem blob store (PLAN §6.9).
func (c *Core) documentsLocalPath(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	d, err := c.store.Documents.Get(args.ID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	local, ok := c.blobs.(blob.LocalStore)
	if !ok {
		return nil, errNoLocalBlobStore
	}
	present, err := c.ensureLocalBytes(d.SHA256)
	if err != nil {
		return nil, err
	}
	path := ""
	if present {
		path = local.Path(d.SHA256)
	}
	return json.Marshal(map[string]any{"present": present, "path": path, "sha256": d.SHA256, "mime": d.Mime, "filename": d.Filename})
}

// ensureLocalBytes guarantees the bytes for sha are present in the blob store, downloading
// them from the server on demand when sync is configured (PLAN §6.9). Reports final presence.
func (c *Core) ensureLocalBytes(sha string) (bool, error) {
	if c.blobs == nil {
		return false, nil
	}
	present, err := c.blobs.Has(sha)
	if err != nil {
		return false, err
	}
	if present {
		return true, nil
	}
	if c.sync.baseURL == "" {
		return false, nil // no server to fetch from
	}
	if err := c.blobs.Download(sha, c.blobURL(sha), c.sync.token); err != nil {
		return false, err
	}
	return true, nil
}

// documentsEnsureLocal guarantees a document's bytes are present locally, downloading them
// lazily from the server on first render if needed (PLAN §6.9). It returns whether the
// bytes are now present and its sha256, so the shell can resolve a platform render URL from
// its own blob store (a file path on native, an object URL on web). Bytes never cross this
// bridge — only the "is it here" answer does.
func (c *Core) documentsEnsureLocal(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	d, err := c.store.Documents.Get(args.ID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	if c.blobs == nil {
		return json.Marshal(map[string]any{"present": false, "downloaded": false, "sha256": d.SHA256})
	}
	had, err := c.blobs.Has(d.SHA256)
	if err != nil {
		return nil, err
	}
	present, err := c.ensureLocalBytes(d.SHA256)
	if err != nil {
		return nil, err
	}
	return json.Marshal(map[string]any{"present": present, "downloaded": present && !had, "sha256": d.SHA256})
}

// blobURL is the server endpoint for a blob's bytes (PLAN §6.9): PUT to upload, GET to
// download.
func (c *Core) blobURL(sha256 string) string {
	return c.sync.baseURL + "/v1/blobs/" + sha256
}

// uploadPendingBlobs streams the bytes of every not-yet-uploaded document to the server and
// marks them uploaded, so the sync engine may then push their metadata (upload-before-push,
// PLAN §6.9). Called at the top of a sync cycle. A per-document failure is skipped, not
// fatal: that row simply stays withheld from the push and retries next cycle. No-op when no
// blob store is injected.
func (c *Core) uploadPendingBlobs() error {
	if c.blobs == nil {
		return nil
	}
	pending, err := c.store.Documents.PendingUpload()
	if err != nil {
		return err
	}
	for _, d := range pending {
		if err := c.blobs.Upload(d.SHA256, c.blobURL(d.SHA256), c.sync.token); err != nil {
			continue // withheld from push; retries next cycle
		}
		if err := c.store.Documents.MarkUploaded(d.ID); err != nil {
			return err
		}
	}
	return nil
}
