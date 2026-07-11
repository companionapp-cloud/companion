package syncserver

import (
	"bufio"
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"companion/core/store"
)

// A connected SSE stream receives a `change` event after another device pushes, so
// device B learns to sync within about a second instead of waiting for its timer
// (PLAN §7.5).
func TestEventsNotifyOnPush(t *testing.T) {
	ts := newServer(t)
	token := register(t, ts.URL, "e@b.co", "password")

	// Open the SSE stream as device B.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/v1/sync/events", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("open events: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("events status = %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("content-type = %q, want text/event-stream", ct)
	}

	changes := make(chan string, 4)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		for sc.Scan() {
			line := sc.Text()
			if strings.HasPrefix(line, "data:") {
				changes <- strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			}
		}
	}()

	// The server registers the subscriber synchronously before its first flush, but
	// that flush races the client goroutine above starting to read; give it a beat.
	time.Sleep(100 * time.Millisecond)

	// Device A creates a note and pushes.
	a := newClient(t, ts.URL, token, "devA")
	if _, err := a.store.Notes.Create(store.CreateNoteInput{Title: "Live"}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := a.engine.Sync(); err != nil {
		t.Fatalf("A sync: %v", err)
	}

	select {
	case data := <-changes:
		if !strings.Contains(data, "server_seq") {
			t.Errorf("change data = %q, want server_seq", data)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no change event within 3s of push")
	}
}
