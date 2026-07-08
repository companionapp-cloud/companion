// Package blob owns document bytes: the content-addressed local store the core depends on
// for file embeds (PLAN §6.9, §3.3). Bytes are keyed by their lowercase-hex SHA256 content
// address, so they are immutable, deduplicated, and integrity-checkable. Desktop and mobile
// inject the filesystem-backed FSStore (fsstore.go); the web shell injects a JS
// implementation over OPFS + fetch (jsstore.go, wasm only), so raw bytes never cross the
// JS↔wasm bridge.
package blob

import (
	"errors"
	"io"
)

// Store is the platform-provided blob store the core orchestrates during sync. Core never
// handles raw bytes itself: it tells the store what to move (Upload/Download against the
// server's blob endpoints) and asks whether bytes are present (Has).
type Store interface {
	// Has reports whether the bytes for sha256 are present locally.
	Has(sha256 string) (bool, error)
	// Upload streams the local bytes for sha256 to the server (HTTP PUT to url, with the
	// bearer token). Fails if the bytes are not present locally.
	Upload(sha256, url, token string) error
	// Download fetches the bytes for sha256 from the server (HTTP GET url, bearer token)
	// into local storage, verifying the content hash on arrival.
	Download(sha256, url, token string) error
	// Delete removes the local bytes for sha256. A no-op if already absent (blob GC when
	// no live document row references the hash, PLAN §6.9).
	Delete(sha256 string) error
}

// LocalStore is a Store whose bytes live somewhere the shell can also reach directly — the
// filesystem impl on desktop and mobile (PLAN §6.9). It lets the shell ingest a picked file
// and resolve an embed to a real path, without the bytes crossing the core's JSON bridge.
// The web OPFS store does this entirely JS-side and does not implement it, so the core
// type-asserts for LocalStore before offering path-based ingestion (documents.ingestFile /
// documents.localPath).
type LocalStore interface {
	Store
	// Put stages bytes from r under their content address, returning the sha256 and size.
	Put(r io.Reader) (sha256 string, size int64, err error)
	// IngestPath stages the file at a native filesystem path (e.g. from an OS file picker),
	// returning its content address and size.
	IngestPath(path string) (sha256 string, size int64, err error)
	// Open returns a reader over the local bytes for sha256, or ErrNotPresent.
	Open(sha256 string) (io.ReadCloser, error)
	// Path returns where sha256's bytes live locally (present or not).
	Path(sha256 string) string
}

// ErrHashMismatch is returned when downloaded bytes do not hash to their expected address.
var ErrHashMismatch = errors.New("blob: content hash mismatch")

// ErrNotPresent is returned when an operation needs local bytes that are absent.
var ErrNotPresent = errors.New("blob: bytes not present locally")
