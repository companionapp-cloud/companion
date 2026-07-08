package domain

import (
	"errors"
	"regexp"
	"strings"
	"time"
)

// Document is a file embedded in a note — a PDF, audio clip, image, or any attachment
// (PLAN §6.9). The row is metadata only: the bytes live in a content-addressed BlobStore
// keyed by SHA256 (core/blob), synced out-of-band through the server's S3-compatible blob
// endpoints. Because bytes are immutable and content-addressed, "replacing" a file writes
// new bytes under a new hash and updates SHA256 — bytes never mutate, so they never
// conflict; only this metadata row plays by the §7.3 conflict rule.
//
// A document is also a first-class graph node (the NodeDocument type): notes point at it
// with an ![[doc:<id>]] embed, which the link extractor derives into an 'embed' edge, the
// same path task embeds use (PLAN §6.2, §5.1). A document has no markdown body of its own,
// so it is only ever a link *target*, never a source.
type Document struct {
	ID       string `json:"id"`
	Filename string `json:"filename"`
	Mime     string `json:"mime"`
	Size     int64  `json:"size"`
	// SHA256 is the lowercase hex content address of the bytes. Immutable for a given
	// byte payload; changing the file changes the hash.
	SHA256 string `json:"sha256"`
	// BlobUploaded is a client-only flag (like Dirty): the bytes have been confirmed at
	// the server's blob store, so the metadata row is safe to push (PLAN §6.9,
	// upload-before-push). It never crosses the wire. Local *presence* of the bytes is
	// never a column — ask BlobStore.Has(sha256).
	BlobUploaded bool      `json:"-"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
	// DeletingAt is the Trash marker (PLAN §4.3), like notes and tasks: a trashed document
	// is hidden from every query but the Trash and still syncs until the server purges it.
	DeletingAt *time.Time `json:"deletingAt,omitempty"`
	DeletedAt  *time.Time `json:"deletedAt,omitempty"`
	Version    int64      `json:"version"`
	Dirty      bool       `json:"dirty"`
}

// ErrInvalidDocument is returned when a document fails validation.
var ErrInvalidDocument = errors.New("invalid document")

// sha256Re matches a lowercase 64-character hex SHA256 digest.
var sha256Re = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Validate checks the invariants that must hold before a document is persisted.
func (d *Document) Validate() error {
	if strings.TrimSpace(d.ID) == "" {
		return errors.Join(ErrInvalidDocument, errors.New("id is required"))
	}
	if strings.TrimSpace(d.Filename) == "" {
		return errors.Join(ErrInvalidDocument, errors.New("filename is required"))
	}
	if !sha256Re.MatchString(d.SHA256) {
		return errors.Join(ErrInvalidDocument, errors.New("sha256 must be a lowercase 64-char hex digest"))
	}
	if d.Size < 0 {
		return errors.Join(ErrInvalidDocument, errors.New("size must not be negative"))
	}
	return nil
}

// SyncEntity implementation (PLAN §7). A trashed document (DeletingAt set) is not a
// tombstone; it keeps syncing until the server's collector purges it (PLAN §7.6).
func (d *Document) SyncID() string           { return d.ID }
func (d *Document) SyncVersion() int64        { return d.Version }
func (d *Document) SyncUpdatedAt() time.Time { return d.UpdatedAt }
func (d *Document) SyncDeleted() bool         { return d.DeletedAt != nil }
func (d *Document) SyncDirty() bool           { return d.Dirty }
