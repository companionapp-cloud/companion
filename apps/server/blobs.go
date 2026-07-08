package main

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"regexp"
)

// The blob endpoints move document bytes between clients and object storage (PLAN §6.9).
// Bytes are content-addressed, so the path is the sha256 and the stored key is scoped per
// user ({user_id}/{sha256}). Clients upload a document's bytes here before pushing its
// metadata row (upload-before-push) and download lazily on first render.

var blobSHARe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// handleBlobPut streams an upload into object storage, verifying that the bytes hash to the
// sha256 in the path before committing (PLAN §6.9). It buffers to a temp file so the hash is
// checked against the whole payload and the size is bounded without holding it in memory.
func (s *Server) handleBlobPut(w http.ResponseWriter, r *http.Request) {
	uid := userID(r)
	sha := r.PathValue("sha256")
	if !blobSHARe.MatchString(sha) {
		writeErr(w, http.StatusBadRequest, "invalid content address")
		return
	}

	tmp, err := os.CreateTemp("", "blobup-*")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "upload failed")
		return
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	defer tmp.Close()

	// Read one byte past the limit so an over-size upload is detectable, then reject it.
	h := sha256.New()
	limited := io.LimitReader(r.Body, s.maxBlobSize+1)
	n, err := io.Copy(io.MultiWriter(tmp, h), limited)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "upload failed")
		return
	}
	if n > s.maxBlobSize {
		writeErr(w, http.StatusRequestEntityTooLarge, "blob exceeds maximum size")
		return
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != sha {
		writeErr(w, http.StatusBadRequest, "content hash mismatch")
		return
	}

	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		writeErr(w, http.StatusInternalServerError, "upload failed")
		return
	}
	if err := s.blobs.Put(r.Context(), blobKey(uid, sha), tmp, n); err != nil {
		writeErr(w, http.StatusInternalServerError, "store failed")
		return
	}
	w.WriteHeader(http.StatusOK)
}

// handleBlobGet streams a document's bytes back to the client (PLAN §6.9), or 404 when the
// bytes are absent from object storage.
func (s *Server) handleBlobGet(w http.ResponseWriter, r *http.Request) {
	uid := userID(r)
	sha := r.PathValue("sha256")
	if !blobSHARe.MatchString(sha) {
		writeErr(w, http.StatusBadRequest, "invalid content address")
		return
	}
	rc, err := s.blobs.Get(r.Context(), blobKey(uid, sha))
	if err == errBlobNotFound {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "fetch failed")
		return
	}
	defer rc.Close()
	// Content addressing makes bytes immutable: a given sha256 never changes, so allow
	// aggressive caching.
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.WriteHeader(http.StatusOK)
	io.Copy(w, rc)
}

// blobKey scopes a content address to its owner (PLAN §6.9): {user_id}/{sha256}.
func blobKey(uid, sha string) string { return uid + "/" + sha }
