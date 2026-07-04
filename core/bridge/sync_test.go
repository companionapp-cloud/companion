package bridge

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"companion/core/domain"
	"companion/core/store"
	"companion/core/sync/protocol"
)

func TestSyncRunNotConfigured(t *testing.T) {
	c, _ := newTestCore(t)
	if _, err := c.Invoke("sync.run", nil); err == nil {
		t.Fatal("expected error when sync is not configured")
	}
}

// stubServer accepts every pushed row (version 1) and returns no pulls — enough to
// verify the bridge drives a real push/pull cycle end to end.
func stubServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/sync/push", func(w http.ResponseWriter, r *http.Request) {
		var req protocol.PushRequest
		json.NewDecoder(r.Body).Decode(&req)
		resp := protocol.PushResponse{}
		for _, ch := range req.Changes {
			resp.Results = append(resp.Results, protocol.PushResult{ID: ch.ID, Status: protocol.StatusAccepted, Version: 1})
		}
		json.NewEncoder(w).Encode(resp)
	})
	mux.HandleFunc("GET /v1/sync/pull", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(protocol.PullResponse{Changes: []protocol.PullChange{}, NextCursor: 0})
	})
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts
}

func TestSyncConfigureAndRun(t *testing.T) {
	st, err := store.Open(":memory:", domain.SystemClock{})
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	c := New(st)
	h := &capturingHandler{}
	c.SetEventHandler(h)

	// a locally-created note starts dirty
	created, _ := st.Notes.Create(store.CreateNoteInput{Title: "Sync me"})
	if !created.Dirty {
		t.Fatal("new note should be dirty")
	}

	ts := stubServer(t)
	if _, err := c.Invoke("sync.configure", []byte(`{"baseUrl":"`+ts.URL+`","token":"t"}`)); err != nil {
		t.Fatalf("configure: %v", err)
	}
	if _, err := c.Invoke("sync.run", nil); err != nil {
		t.Fatalf("run: %v", err)
	}

	got, _ := st.Notes.Get(created.ID)
	if got.Dirty {
		t.Error("note should be clean after a successful push")
	}
	if got.Version != 1 {
		t.Errorf("note version = %d, want 1", got.Version)
	}
	// sync emits a change event for the UI to refresh
	var found bool
	for _, e := range h.events {
		if e == "notes.changed" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected notes.changed event, got %v", h.events)
	}
}
