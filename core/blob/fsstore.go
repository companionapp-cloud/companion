//go:build !js

package blob

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

// FSStore is a filesystem-backed Store rooted at a base directory (PLAN §6.9). It is the
// single Go implementation desktop (Wails) and mobile (gomobile) share: the shell passes
// the app-sandbox documents path at init. Bytes live at <base>/<sha256>; writes are atomic
// (temp file + rename) and hash-verified, so a partial transfer never yields a corrupt
// blob at a valid address.
type FSStore struct {
	base   string
	client *http.Client
}

// NewFSStore builds a filesystem blob store under base, creating it if needed. A nil client
// defaults to http.DefaultClient.
func NewFSStore(base string, client *http.Client) (*FSStore, error) {
	if err := os.MkdirAll(base, 0o755); err != nil {
		return nil, fmt.Errorf("blob: create base dir: %w", err)
	}
	if client == nil {
		client = http.DefaultClient
	}
	return &FSStore{base: base, client: client}, nil
}

// Path returns the absolute path where sha256's bytes live (present or not). The shell uses
// it to hand a real file path to the mobile webview or a desktop custom-scheme handler for
// rendering, without the bytes passing through core (PLAN §6.9).
func (s *FSStore) Path(sha256 string) string { return filepath.Join(s.base, sha256) }

// Has reports whether the bytes for sha256 exist locally.
func (s *FSStore) Has(sha string) (bool, error) {
	_, err := os.Stat(s.Path(sha))
	if err == nil {
		return true, nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return false, err
}

// Put streams r into the store, computing the content address as it goes, and returns the
// sha256 and byte size. Used by the shell to ingest a picked/dropped/pasted file before
// calling documents.create. The write is atomic and idempotent: re-putting identical bytes
// lands on the same address.
func (s *FSStore) Put(r io.Reader) (sha string, size int64, err error) {
	tmp, err := os.CreateTemp(s.base, ".ingest-*")
	if err != nil {
		return "", 0, fmt.Errorf("blob: create temp: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op after a successful rename
	h := sha256.New()
	size, err = io.Copy(io.MultiWriter(tmp, h), r)
	if err != nil {
		tmp.Close()
		return "", 0, fmt.Errorf("blob: write temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return "", 0, fmt.Errorf("blob: close temp: %w", err)
	}
	sha = hex.EncodeToString(h.Sum(nil))
	if err := os.Rename(tmpName, s.Path(sha)); err != nil {
		return "", 0, fmt.Errorf("blob: commit: %w", err)
	}
	return sha, size, nil
}

// IngestPath stages the file at path into the store, returning its content address and
// size. Used by shells that receive a filesystem path from an OS file picker (mobile) rather
// than an in-memory blob.
func (s *FSStore) IngestPath(path string) (sha string, size int64, err error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, fmt.Errorf("blob: open source: %w", err)
	}
	defer f.Close()
	return s.Put(f)
}

// Open returns a reader over the local bytes for sha256, or ErrNotPresent.
func (s *FSStore) Open(sha string) (io.ReadCloser, error) {
	f, err := os.Open(s.Path(sha))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotPresent
	}
	if err != nil {
		return nil, err
	}
	return f, nil
}

// Delete removes the local bytes for sha256 (idempotent).
func (s *FSStore) Delete(sha string) error {
	err := os.Remove(s.Path(sha))
	if err == nil || errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// Upload streams the local bytes for sha to the server (PUT url). The server verifies the
// hash on receipt (PLAN §6.9); the metadata row is not pushed until this succeeds.
func (s *FSStore) Upload(sha, url, token string) error {
	f, err := s.Open(sha)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := os.Stat(s.Path(sha))
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPut, url, f)
	if err != nil {
		return err
	}
	req.ContentLength = info.Size()
	req.Header.Set("Content-Type", "application/octet-stream")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("blob: upload %s: %s: %s", sha, resp.Status, msg)
	}
	io.Copy(io.Discard, resp.Body)
	return nil
}

// Download fetches sha's bytes from the server (GET url) into local storage, verifying the
// content hash before committing. A mismatch discards the download and returns
// ErrHashMismatch — a corrupt or wrong payload never lands at a valid address.
func (s *FSStore) Download(sha, url, token string) error {
	if present, err := s.Has(sha); err != nil {
		return err
	} else if present {
		return nil // already have it; download is idempotent
	}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("blob: download %s: %s: %s", sha, resp.Status, msg)
	}
	got, _, err := s.Put(resp.Body)
	if err != nil {
		return err
	}
	if got != sha {
		s.Delete(got)
		return fmt.Errorf("%w: got %s want %s", ErrHashMismatch, got, sha)
	}
	return nil
}

// Ensure FSStore satisfies the port (and the richer local-access interface).
var _ Store = (*FSStore)(nil)
var _ LocalStore = (*FSStore)(nil)
