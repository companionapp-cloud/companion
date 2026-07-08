package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"strings"
	"testing"
)

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// blobReq issues an authenticated request to the blob endpoint and returns status + body.
func blobReq(t *testing.T, method, baseURL, token, sha string, body []byte) (int, []byte) {
	t.Helper()
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, baseURL+"/v1/blobs/"+sha, r)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, out
}

// A blob round-trips: upload with a matching content address, then download it back.
func TestBlobPutGetRoundTrip(t *testing.T) {
	ts := newServer(t)
	token := register(t, ts.URL, "blob@b.co", "password")

	content := []byte("a small pdf payload")
	sha := sha256Hex(content)

	if status, body := blobReq(t, http.MethodPut, ts.URL, token, sha, content); status != http.StatusOK {
		t.Fatalf("PUT status = %d (%s), want 200", status, body)
	}
	status, got := blobReq(t, http.MethodGet, ts.URL, token, sha, nil)
	if status != http.StatusOK {
		t.Fatalf("GET status = %d, want 200", status)
	}
	if !bytes.Equal(got, content) {
		t.Errorf("GET body = %q, want %q", got, content)
	}
}

// The server rejects an upload whose bytes do not hash to the address in the path.
func TestBlobPutHashMismatch(t *testing.T) {
	ts := newServer(t)
	token := register(t, ts.URL, "mismatch@b.co", "password")

	wrongSha := sha256Hex([]byte("what we claim"))
	status, _ := blobReq(t, http.MethodPut, ts.URL, token, wrongSha, []byte("what we actually send"))
	if status != http.StatusBadRequest {
		t.Errorf("PUT with wrong hash = %d, want 400", status)
	}
	// And nothing was stored under that address.
	if status, _ := blobReq(t, http.MethodGet, ts.URL, token, wrongSha, nil); status != http.StatusNotFound {
		t.Errorf("GET after rejected PUT = %d, want 404", status)
	}
}

// A malformed content address is rejected before any storage work.
func TestBlobInvalidAddress(t *testing.T) {
	ts := newServer(t)
	token := register(t, ts.URL, "badaddr@b.co", "password")
	if status, _ := blobReq(t, http.MethodGet, ts.URL, token, "not-a-sha", nil); status != http.StatusBadRequest {
		t.Errorf("GET bad address = %d, want 400", status)
	}
}

// The blob endpoints require authentication.
func TestBlobRequiresAuth(t *testing.T) {
	ts := newServer(t)
	sha := sha256Hex([]byte("x"))
	if status, _ := blobReq(t, http.MethodGet, ts.URL, "", sha, nil); status != http.StatusUnauthorized {
		t.Errorf("unauthenticated GET = %d, want 401", status)
	}
}

// Blobs are scoped per user: one user's upload is invisible to another, even at the same
// content address (keys are {user_id}/{sha256}).
func TestBlobPerUserScoping(t *testing.T) {
	ts := newServer(t)
	tokenA := register(t, ts.URL, "usera@b.co", "password")
	tokenB := register(t, ts.URL, "userb@b.co", "password")

	content := []byte("A's private document")
	sha := sha256Hex(content)
	if status, _ := blobReq(t, http.MethodPut, ts.URL, tokenA, sha, content); status != http.StatusOK {
		t.Fatalf("A PUT = %d, want 200", status)
	}
	// B asks for the same content address and must not receive A's bytes.
	if status, _ := blobReq(t, http.MethodGet, ts.URL, tokenB, sha, nil); status != http.StatusNotFound {
		t.Errorf("B GET of A's blob = %d, want 404", status)
	}
}

// An upload larger than the configured cap is rejected.
func TestBlobSizeLimit(t *testing.T) {
	ts, api := newServerAPI(t)
	api.maxBlobSize = 16 // tiny cap for the test
	token := register(t, ts.URL, "toobig@b.co", "password")

	big := []byte(strings.Repeat("x", 64))
	sha := sha256Hex(big)
	if status, _ := blobReq(t, http.MethodPut, ts.URL, token, sha, big); status != http.StatusRequestEntityTooLarge {
		t.Errorf("oversize PUT = %d, want 413", status)
	}
}
