package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"companion/core/domain"
	"companion/core/store"
	syncpkg "companion/core/sync"
)

type testClock struct{ t time.Time }

func (c *testClock) Now() time.Time { return c.t }

var base = time.Date(2020, 1, 1, 12, 0, 0, 0, time.UTC)

func register(t *testing.T, baseURL, email, pw string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"email": email, "password": pw})
	resp, err := http.Post(baseURL+"/v1/auth/register", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("register status = %d", resp.StatusCode)
	}
	var out struct{ Token string }
	json.NewDecoder(resp.Body).Decode(&out)
	if out.Token == "" {
		t.Fatal("empty token")
	}
	return out.Token
}

type client struct {
	store  *store.Store
	engine *syncpkg.Engine
	clk    *testClock
}

func newClient(t *testing.T, baseURL, token, device string) *client {
	t.Helper()
	clk := &testClock{t: base}
	st, err := store.Open(":memory:", clk)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	if err := st.EnsureSyncState(device); err != nil {
		t.Fatalf("ensure sync state: %v", err)
	}
	return &client{store: st, engine: syncpkg.New(st, syncpkg.NewHTTPTransport(baseURL, token), clk), clk: clk}
}

func newServer(t *testing.T) *httptest.Server {
	t.Helper()
	// Postgres when COMPANION_TEST_DB is set (e.g. against `make db-up`), else
	// in-memory SQLite for fast headless runs. Same queries via dialect rebind.
	dsn := os.Getenv("COMPANION_TEST_DB")
	if dsn == "" {
		dsn = ":memory:"
	}
	db, dialect, err := openDB(dsn)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if dialect == "postgres" {
		// Guard: TRUNCATE is destructive, so refuse anything that isn't clearly a
		// test database. Point COMPANION_TEST_DB at the compose companion_test DB.
		if !strings.Contains(dsn, "test") {
			t.Fatalf("refusing to run destructive tests on %q; use a *_test database (COMPANION_TEST_DB)", dsn)
		}
		if _, err := db.Exec(`TRUNCATE users, sessions, user_seq, notes, user_secrets;`); err != nil {
			t.Fatalf("truncate: %v", err)
		}
	}
	ts := httptest.NewServer(NewServer(db, dialect).Handler())
	t.Cleanup(func() { ts.Close(); db.Close() })
	return ts
}

func titles(notes []*domain.Note) []string {
	out := make([]string, len(notes))
	for i, n := range notes {
		out[i] = n.Title
	}
	return out
}

// A creates and edits notes; B converges to the same state through the server.
func TestSyncPropagation(t *testing.T) {
	ts := newServer(t)
	token := register(t, ts.URL, "a@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	note, _ := a.store.Notes.Create(store.CreateNoteInput{Title: "Hello", ContentMD: "world"})
	if err := a.engine.Sync(); err != nil {
		t.Fatalf("A sync: %v", err)
	}
	if err := b.engine.Sync(); err != nil {
		t.Fatalf("B sync: %v", err)
	}

	got, _ := b.store.Notes.Get(note.ID)
	if got == nil || got.Title != "Hello" || got.ContentMD != "world" {
		t.Fatalf("B did not receive note: %+v", got)
	}
	if got.Version == 0 || got.Dirty {
		t.Errorf("synced note should have a server version and be clean: %+v", got)
	}

	// A edits; B converges.
	a.clk.t = base.Add(time.Hour)
	a.store.Notes.Update(note.ID, store.UpdateNoteInput{Title: strPtr("Renamed")})
	a.engine.Sync()
	b.engine.Sync()
	got, _ = b.store.Notes.Get(note.ID)
	if got.Title != "Renamed" {
		t.Errorf("B title = %q, want Renamed", got.Title)
	}
}

// A delete propagates as a tombstone; B's copy disappears from normal reads.
func TestSyncDelete(t *testing.T) {
	ts := newServer(t)
	token := register(t, ts.URL, "d@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	note, _ := a.store.Notes.Create(store.CreateNoteInput{Title: "Doomed"})
	a.engine.Sync()
	b.engine.Sync()

	a.clk.t = base.Add(time.Hour)
	a.store.Notes.Delete(note.ID)
	a.engine.Sync()
	b.engine.Sync()

	if _, err := b.store.Notes.Get(note.ID); err != store.ErrNotFound {
		t.Errorf("B should not see deleted note, err = %v", err)
	}
	// tombstone is present (via GetAny)
	tomb, err := b.store.Notes.GetAny(note.ID)
	if err != nil || tomb.DeletedAt == nil {
		t.Errorf("expected tombstone on B, got %+v (err %v)", tomb, err)
	}
}

// Concurrent edits: the newer edit (A) wins on the server; B's losing edit survives
// as a conflicted copy (§5.3).
func TestSyncConflictedCopy(t *testing.T) {
	ts := newServer(t)
	token := register(t, ts.URL, "c@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	note, _ := a.store.Notes.Create(store.CreateNoteInput{Title: "Shared"})
	a.engine.Sync()
	b.engine.Sync()

	// Both edit offline; A's edit is newer than B's.
	a.clk.t = base.Add(2 * time.Hour)
	a.store.Notes.Update(note.ID, store.UpdateNoteInput{Title: strPtr("A wins")})
	b.clk.t = base.Add(1 * time.Hour)
	b.store.Notes.Update(note.ID, store.UpdateNoteInput{Title: strPtr("B loses")})

	// A syncs first (accepted), then B (stale push -> server wins -> conflicted copy).
	if err := a.engine.Sync(); err != nil {
		t.Fatalf("A sync: %v", err)
	}
	if err := b.engine.Sync(); err != nil {
		t.Fatalf("B sync: %v", err)
	}

	notes, _ := b.store.Notes.List()
	if len(notes) != 2 {
		t.Fatalf("B should have 2 notes (winner + conflicted copy), got %d: %v", len(notes), titles(notes))
	}
	canonical, _ := b.store.Notes.Get(note.ID)
	if canonical.Title != "A wins" {
		t.Errorf("canonical title = %q, want 'A wins'", canonical.Title)
	}
	var hasCopy bool
	for _, n := range notes {
		if strings.Contains(n.Title, "conflicted copy") && strings.HasPrefix(n.Title, "B loses") {
			hasCopy = true
			if !n.Dirty {
				t.Error("conflicted copy should be dirty (pushes next cycle)")
			}
		}
	}
	if !hasCopy {
		t.Errorf("expected a 'B loses (conflicted copy …)' note; got %v", titles(notes))
	}
}

func strPtr(s string) *string { return &s }
