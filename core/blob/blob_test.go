//go:build !js

package blob

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newStore(t *testing.T) *FSStore {
	t.Helper()
	s, err := NewFSStore(t.TempDir(), nil)
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	return s
}

func hashOf(b string) string {
	sum := sha256.Sum256([]byte(b))
	return hex.EncodeToString(sum[:])
}

func TestFSStorePutOpenHasDelete(t *testing.T) {
	s := newStore(t)
	const content = "hello, documents"
	want := hashOf(content)

	sha, size, err := s.Put(strings.NewReader(content))
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	if sha != want {
		t.Errorf("content address = %s, want %s", sha, want)
	}
	if size != int64(len(content)) {
		t.Errorf("size = %d, want %d", size, len(content))
	}

	has, err := s.Has(sha)
	if err != nil || !has {
		t.Fatalf("Has after Put = %v, %v; want true", has, err)
	}

	rc, err := s.Open(sha)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	got, _ := io.ReadAll(rc)
	rc.Close()
	if string(got) != content {
		t.Errorf("read back %q, want %q", got, content)
	}

	if err := s.Delete(sha); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if has, _ := s.Has(sha); has {
		t.Error("Has after Delete should be false")
	}
	// Delete is idempotent.
	if err := s.Delete(sha); err != nil {
		t.Errorf("second delete should be a no-op, got %v", err)
	}
}

func TestFSStoreOpenMissing(t *testing.T) {
	s := newStore(t)
	if _, err := s.Open(hashOf("absent")); err != ErrNotPresent {
		t.Errorf("open missing = %v, want ErrNotPresent", err)
	}
}

func TestFSStoreUploadDownloadRoundTrip(t *testing.T) {
	const content = "audio bytes here"
	sha := hashOf(content)

	// A fake blob server: PUT stores the body, GET returns it, keyed by the path (sha).
	store := map[string][]byte{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		key := strings.TrimPrefix(r.URL.Path, "/v1/blobs/")
		switch r.Method {
		case http.MethodPut:
			body, _ := io.ReadAll(r.Body)
			store[key] = body
			w.WriteHeader(http.StatusOK)
		case http.MethodGet:
			body, ok := store[key]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Write(body)
		}
	}))
	defer srv.Close()

	up := newStore(t)
	if _, _, err := up.Put(strings.NewReader(content)); err != nil {
		t.Fatalf("put: %v", err)
	}
	url := srv.URL + "/v1/blobs/" + sha
	if err := up.Upload(sha, url, "tok"); err != nil {
		t.Fatalf("upload: %v", err)
	}
	if _, ok := store[sha]; !ok {
		t.Fatal("server did not receive the blob")
	}

	// A fresh store downloads and verifies the hash.
	down := newStore(t)
	if err := down.Download(sha, url, "tok"); err != nil {
		t.Fatalf("download: %v", err)
	}
	rc, err := down.Open(sha)
	if err != nil {
		t.Fatalf("open downloaded: %v", err)
	}
	got, _ := io.ReadAll(rc)
	rc.Close()
	if string(got) != content {
		t.Errorf("downloaded %q, want %q", got, content)
	}
}

func TestFSStoreDownloadHashMismatch(t *testing.T) {
	// Server returns bytes that don't match the requested address.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("tampered payload"))
	}))
	defer srv.Close()

	s := newStore(t)
	wrong := hashOf("what we asked for")
	err := s.Download(wrong, srv.URL+"/v1/blobs/"+wrong, "")
	if err == nil {
		t.Fatal("expected a hash-mismatch error")
	}
	if has, _ := s.Has(wrong); has {
		t.Error("mismatched bytes must not be committed at the requested address")
	}
	// And the actual (wrong) hash must not be left lying around either.
	if has, _ := s.Has(hashOf("tampered payload")); has {
		t.Error("download must not commit bytes under the payload's own hash")
	}
}

func TestFSStoreUploadMissingBytes(t *testing.T) {
	s := newStore(t)
	if err := s.Upload(hashOf("nope"), "http://example.invalid", ""); err != ErrNotPresent {
		t.Errorf("upload without local bytes = %v, want ErrNotPresent", err)
	}
}
