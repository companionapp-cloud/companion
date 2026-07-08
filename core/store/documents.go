package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"companion/core/domain"
	"companion/core/sync/protocol"

	"github.com/google/uuid"
)

// DocumentsRepo is the CRUD + sync repository for documents — file embeds in notes
// (PLAN §6.9). A document row is metadata only (filename, mime, size, sha256); the bytes
// live in the BlobStore. Unlike notes and tasks a document has no markdown body, so it is
// never a link *source* — it only appears in the graph as a node and as the target of a
// note's ![[doc:<id>]] embed edge, which the notes/tasks extractor derives. Trash semantics
// mirror notes and tasks (PLAN §4.3).
type DocumentsRepo struct {
	db    Driver
	clock domain.Clock
	links *LinksRepo
}

const documentColumns = `id, filename, mime, size, sha256, blob_uploaded, created_at, updated_at, deleting_at, deleted_at, version, dirty`

// CreateDocumentInput carries the client-supplied metadata for a new document. The shell
// has already staged the bytes into the BlobStore and computed sha256/size; core never
// sees the bytes (PLAN §6.9).
type CreateDocumentInput struct {
	Filename string `json:"filename"`
	Mime     string `json:"mime"`
	Size     int64  `json:"size"`
	SHA256   string `json:"sha256"`
}

// Create inserts a new document (client UUIDv7, version 0, dirty). blob_uploaded starts
// false: the sync engine uploads the bytes before the metadata row is pushed
// (upload-before-push, PLAN §6.9).
func (r *DocumentsRepo) Create(in CreateDocumentInput) (*domain.Document, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return nil, fmt.Errorf("generate uuid: %w", err)
	}
	now := r.clock.Now().UTC()
	mime := in.Mime
	if mime == "" {
		mime = "application/octet-stream"
	}
	d := &domain.Document{
		ID: id.String(), Filename: in.Filename, Mime: mime, Size: in.Size, SHA256: in.SHA256,
		CreatedAt: now, UpdatedAt: now, Version: 0, Dirty: true,
	}
	if err := d.Validate(); err != nil {
		return nil, err
	}
	if _, err := r.db.Exec(
		`INSERT INTO documents (id, filename, mime, size, sha256, blob_uploaded, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?);`,
		d.ID, d.Filename, d.Mime, d.Size, d.SHA256,
		d.CreatedAt.Format(timeFormat), d.UpdatedAt.Format(timeFormat), d.Version, boolToInt(d.Dirty),
	); err != nil {
		return nil, fmt.Errorf("insert document: %w", err)
	}
	return d, nil
}

// Get returns a single live document by id (not deleted, not trashed), or ErrNotFound.
func (r *DocumentsRepo) Get(id string) (*domain.Document, error) {
	rows, err := r.db.Query(
		`SELECT `+documentColumns+` FROM documents WHERE id = ? AND deleted_at IS NULL AND deleting_at IS NULL;`, id)
	if err != nil {
		return nil, fmt.Errorf("query document: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanDocument(rows)
}

// List returns all live documents, newest-updated first.
func (r *DocumentsRepo) List() ([]*domain.Document, error) {
	rows, err := r.db.Query(
		`SELECT ` + documentColumns + ` FROM documents
		 WHERE deleted_at IS NULL AND deleting_at IS NULL
		 ORDER BY updated_at DESC, id DESC;`)
	if err != nil {
		return nil, fmt.Errorf("query documents: %w", err)
	}
	defer rows.Close()
	out := []*domain.Document{}
	for rows.Next() {
		d, err := scanDocument(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// Rename updates a document's display filename (its only mutable field — bytes are
// immutable, so mime/size/sha256 never change in place; a replacement is a new document).
// Bumps updated_at, marks dirty. Returns ErrNotFound if missing/trashed.
func (r *DocumentsRepo) Rename(id, filename string) (*domain.Document, error) {
	d, err := r.Get(id)
	if err != nil {
		return nil, err
	}
	d.Filename = filename
	d.UpdatedAt = r.clock.Now().UTC()
	d.Dirty = true
	if err := d.Validate(); err != nil {
		return nil, err
	}
	res, err := r.db.Exec(
		`UPDATE documents SET filename = ?, updated_at = ?, dirty = 1
		 WHERE id = ? AND deleted_at IS NULL AND deleting_at IS NULL;`,
		d.Filename, d.UpdatedAt.Format(timeFormat), id,
	)
	if err != nil {
		return nil, fmt.Errorf("rename document: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return nil, ErrNotFound
	}
	return d, nil
}

// Delete tombstones a document (the terminal "delete forever" primitive; everyday deletion
// goes through Trash). Returns ErrNotFound if already gone. The blob bytes are GC'd
// separately once no live row references the hash (PLAN §6.9).
func (r *DocumentsRepo) Delete(id string) error {
	now := r.clock.Now().UTC()
	res, err := r.db.Exec(
		`UPDATE documents SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ? AND deleted_at IS NULL;`,
		now.Format(timeFormat), now.Format(timeFormat), id,
	)
	if err != nil {
		return fmt.Errorf("delete document: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	return nil
}

// Trash moves a document to the Trash (PLAN §4.3): sets deleting_at = now + TrashRetention.
// ErrNotFound if missing/already trashed/tombstoned.
func (r *DocumentsRepo) Trash(id string) error {
	now := r.clock.Now().UTC()
	deletingAt := now.Add(TrashRetention)
	res, err := r.db.Exec(
		`UPDATE documents SET deleting_at = ?, updated_at = ?, dirty = 1
		 WHERE id = ? AND deleted_at IS NULL AND deleting_at IS NULL;`,
		deletingAt.Format(timeFormat), now.Format(timeFormat), id,
	)
	if err != nil {
		return fmt.Errorf("trash document: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	return nil
}

// Restore brings a document back from the Trash (or a tombstone).
func (r *DocumentsRepo) Restore(id string) error {
	d, err := r.GetAny(id)
	if err != nil {
		return err
	}
	if d.DeletedAt == nil && d.DeletingAt == nil {
		return ErrNotFound
	}
	now := r.clock.Now().UTC()
	res, err := r.db.Exec(
		`UPDATE documents SET deleting_at = NULL, deleted_at = NULL, updated_at = ?, dirty = 1
		 WHERE id = ? AND (deleted_at IS NOT NULL OR deleting_at IS NOT NULL);`,
		now.Format(timeFormat), id,
	)
	if err != nil {
		return fmt.Errorf("restore document: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	return nil
}

// ListTrash returns every trashed document, soonest-to-be-purged first (PLAN §4.3).
func (r *DocumentsRepo) ListTrash() ([]*domain.Document, error) {
	rows, err := r.db.Query(
		`SELECT ` + documentColumns + ` FROM documents WHERE deleted_at IS NULL AND deleting_at IS NOT NULL ORDER BY deleting_at ASC, id ASC;`)
	if err != nil {
		return nil, fmt.Errorf("query trashed documents: %w", err)
	}
	defer rows.Close()
	out := []*domain.Document{}
	for rows.Next() {
		d, err := scanDocument(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// --- blob transfer bookkeeping (PLAN §6.9) --------------------------------

// PendingUpload returns live, dirty documents whose bytes are not yet confirmed at the
// server, oldest-first. The sync engine uploads each blob before pushing the metadata row
// so no device ever pulls a document whose bytes are unfetchable (upload-before-push).
func (r *DocumentsRepo) PendingUpload() ([]*domain.Document, error) {
	rows, err := r.db.Query(
		`SELECT ` + documentColumns + ` FROM documents
		 WHERE dirty = 1 AND blob_uploaded = 0 AND deleted_at IS NULL
		 ORDER BY updated_at ASC, id ASC;`)
	if err != nil {
		return nil, fmt.Errorf("query pending-upload documents: %w", err)
	}
	defer rows.Close()
	out := []*domain.Document{}
	for rows.Next() {
		d, err := scanDocument(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// MarkUploaded records that a document's bytes are confirmed at the server, clearing the
// upload-before-push gate. Idempotent.
func (r *DocumentsRepo) MarkUploaded(id string) error {
	if _, err := r.db.Exec(`UPDATE documents SET blob_uploaded = 1 WHERE id = ?;`, id); err != nil {
		return fmt.Errorf("mark blob uploaded: %w", err)
	}
	return nil
}

// HashReferencedElsewhere reports whether any live document row other than excludeID still
// carries sha256. Blob GC deletes local/remote bytes only when this is false (PLAN §6.9):
// content addressing means two rows may share one blob (the same file attached twice).
func (r *DocumentsRepo) HashReferencedElsewhere(sha256, excludeID string) (bool, error) {
	rows, err := r.db.Query(
		`SELECT 1 FROM documents WHERE sha256 = ? AND id != ? AND deleted_at IS NULL LIMIT 1;`, sha256, excludeID)
	if err != nil {
		return false, fmt.Errorf("query hash refs: %w", err)
	}
	defer rows.Close()
	referenced := rows.Next()
	return referenced, rows.Err()
}

// --- SyncableRepo[*domain.Document] (PLAN §7) -----------------------------

func (r *DocumentsRepo) EntityType() string { return protocol.EntityDocument }

// Dirty returns rows to push. It enforces upload-before-push (PLAN §6.9): a live document
// is withheld from the push until its bytes are confirmed at the server (blob_uploaded),
// so no other device ever pulls metadata whose bytes are unfetchable. Tombstones push
// regardless — a deletion needs no bytes. The blob-upload pass (bridge syncRun) flips
// blob_uploaded, and the row rides the next push.
func (r *DocumentsRepo) Dirty() ([]*domain.Document, error) {
	rows, err := r.db.Query(`SELECT ` + documentColumns + ` FROM documents
		 WHERE dirty = 1 AND (blob_uploaded = 1 OR deleted_at IS NOT NULL)
		 ORDER BY updated_at ASC, id ASC;`)
	if err != nil {
		return nil, fmt.Errorf("query dirty documents: %w", err)
	}
	defer rows.Close()
	out := []*domain.Document{}
	for rows.Next() {
		d, err := scanDocument(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (r *DocumentsRepo) GetAny(id string) (*domain.Document, error) {
	rows, err := r.db.Query(`SELECT `+documentColumns+` FROM documents WHERE id = ?;`, id)
	if err != nil {
		return nil, fmt.Errorf("query document: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanDocument(rows)
}

// Apply overwrites the local row with a server-canonical one and clears dirty. A pulled
// document arrives with blob_uploaded = 1: the bytes already exist at the server (the
// pushing device uploaded them before pushing), so this device may download them lazily on
// first render without needing to re-upload.
func (r *DocumentsRepo) Apply(d *domain.Document) error {
	_, err := r.db.Exec(
		`INSERT INTO documents (id, filename, mime, size, sha256, blob_uploaded, created_at, updated_at, deleting_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   filename = excluded.filename, mime = excluded.mime, size = excluded.size,
		   sha256 = excluded.sha256, blob_uploaded = 1,
		   created_at = excluded.created_at, updated_at = excluded.updated_at,
		   deleting_at = excluded.deleting_at, deleted_at = excluded.deleted_at,
		   version = excluded.version, dirty = 0;`,
		d.ID, d.Filename, d.Mime, d.Size, d.SHA256,
		d.CreatedAt.UTC().Format(timeFormat), d.UpdatedAt.UTC().Format(timeFormat),
		nullTime(d.DeletingAt), nullTime(d.DeletedAt), d.Version,
	)
	if err != nil {
		return fmt.Errorf("apply document: %w", err)
	}
	return nil
}

func (r *DocumentsRepo) MarkPushed(id string, version int64) error {
	if _, err := r.db.Exec(`UPDATE documents SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark pushed: %w", err)
	}
	return nil
}

func (r *DocumentsRepo) MeaningfulDiff(a, b *domain.Document) bool {
	if a.Filename != b.Filename || a.Mime != b.Mime || a.Size != b.Size || a.SHA256 != b.SHA256 {
		return true
	}
	if (a.DeletingAt == nil) != (b.DeletingAt == nil) {
		return true
	}
	return (a.DeletedAt == nil) != (b.DeletedAt == nil)
}

func (r *DocumentsRepo) Decode(raw json.RawMessage) (*domain.Document, error) {
	var d domain.Document
	if err := json.Unmarshal(raw, &d); err != nil {
		return nil, fmt.Errorf("decode document: %w", err)
	}
	return &d, nil
}

// ConflictedCopy forks a losing local document into a fresh row (§7.3). The copy points at
// the same content hash — the bytes are immutable and shared — so no blob is duplicated;
// only the metadata row forks.
func (r *DocumentsRepo) ConflictedCopy(local *domain.Document, suffix string) error {
	id, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("generate uuid: %w", err)
	}
	now := r.clock.Now().UTC()
	filename := local.Filename
	if filename == "" {
		filename = "Untitled"
	}
	// blob_uploaded = 1: the shared bytes are already at the server under this hash, so the
	// forked row needs no upload before it pushes.
	if _, err := r.db.Exec(
		`INSERT INTO documents (id, filename, mime, size, sha256, blob_uploaded, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0, 1);`,
		id.String(), filename+" "+suffix, local.Mime, local.Size, local.SHA256,
		now.Format(timeFormat), now.Format(timeFormat),
	); err != nil {
		return fmt.Errorf("insert conflicted document: %w", err)
	}
	return nil
}

func scanDocument(rows Rows) (*domain.Document, error) {
	var (
		d                     domain.Document
		deletingAt, deletedAt sql.NullString
		createdAt, updatedAt  string
		blobUploaded, dirty   int
	)
	if err := rows.Scan(
		&d.ID, &d.Filename, &d.Mime, &d.Size, &d.SHA256, &blobUploaded,
		&createdAt, &updatedAt, &deletingAt, &deletedAt, &d.Version, &dirty,
	); err != nil {
		return nil, fmt.Errorf("scan document: %w", err)
	}
	var err error
	if d.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if d.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	if d.DeletingAt, err = parseNullTime(deletingAt); err != nil {
		return nil, err
	}
	if d.DeletedAt, err = parseNullTime(deletedAt); err != nil {
		return nil, err
	}
	d.BlobUploaded = blobUploaded != 0
	d.Dirty = dirty != 0
	return &d, nil
}
