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
	ts, _ := newServerAPI(t)
	return ts
}

// newServerAPI is newServer but also hands back the *Server, so tests can drive its
// in-process helpers (e.g. the Trash collector) directly.
func newServerAPI(t *testing.T) (*httptest.Server, *Server) {
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
		if _, err := db.Exec(`TRUNCATE users, sessions, refresh_tokens, user_seq, notes, tasks, areas, projects, project_members, user_secrets;`); err != nil {
			t.Fatalf("truncate: %v", err)
		}
	}
	srv := NewServer(db, dialect)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { ts.Close(); db.Close() })
	return ts, srv
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

// Trash → sync → server collector → sync: A trashes a note; both devices converge to the
// trashed state; the hourly collector (§7.6) tombstones the expired row; both devices then
// pull the tombstone. (Client clock is pinned to 2020, so the real-time server sees the
// deleting_at as long past and purges it.)
func TestTrashSyncAndPurge(t *testing.T) {
	ts, srv := newServerAPI(t)
	token := register(t, ts.URL, "trash@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	note, _ := a.store.Notes.Create(store.CreateNoteInput{Title: "Trashable"})
	a.engine.Sync()
	b.engine.Sync()

	// A trashes; both converge to "in Trash".
	a.clk.t = base.Add(time.Hour)
	if err := a.store.Notes.Trash(note.ID); err != nil {
		t.Fatalf("trash: %v", err)
	}
	a.engine.Sync()
	b.engine.Sync()
	if _, err := b.store.Notes.Get(note.ID); err != store.ErrNotFound {
		t.Errorf("B get trashed note = %v, want ErrNotFound", err)
	}
	if tr, _ := b.store.Notes.ListTrash(); len(tr) != 1 {
		t.Fatalf("B trash len = %d, want 1", len(tr))
	}

	// The collector promotes the expired trashed row to a tombstone.
	n, err := srv.PurgeExpired()
	if err != nil || n != 1 {
		t.Fatalf("PurgeExpired = %d, %v; want 1, nil", n, err)
	}

	// Both devices pull the tombstone: gone from the Trash, present as a tombstone.
	a.engine.Sync()
	b.engine.Sync()
	for name, c := range map[string]*client{"A": a, "B": b} {
		if tr, _ := c.store.Notes.ListTrash(); len(tr) != 0 {
			t.Errorf("%s trash after purge = %d, want 0", name, len(tr))
		}
		tomb, err := c.store.Notes.GetAny(note.ID)
		if err != nil || tomb.DeletedAt == nil {
			t.Errorf("%s expected tombstone after purge, got %+v (err %v)", name, tomb, err)
		}
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

// Tasks sync end-to-end: create on A, converge on B, complete on A, B converges — proving
// the task server handler and the completed_at/status columns round-trip.
func TestTaskSync(t *testing.T) {
	ts := newServer(t)
	token := register(t, ts.URL, "task@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	due := base.Add(48 * time.Hour)
	task, _ := a.store.Tasks.Create(store.CreateTaskInput{Title: "Ship it", DueAt: &due})
	a.engine.Sync()
	b.engine.Sync()

	got, err := b.store.Tasks.Get(task.ID)
	if err != nil || got.Title != "Ship it" {
		t.Fatalf("B did not receive task: %+v (err %v)", got, err)
	}
	if got.DueAt == nil || !got.DueAt.Equal(due) {
		t.Errorf("B due_at = %v, want %v", got.DueAt, due)
	}
	if got.Status != "open" {
		t.Errorf("B status = %q, want open", got.Status)
	}

	// A completes it; B converges and sees completed_at set.
	a.clk.t = base.Add(time.Hour)
	done := "done"
	a.store.Tasks.Update(task.ID, store.UpdateTaskInput{Status: &done})
	a.engine.Sync()
	b.engine.Sync()
	got, _ = b.store.Tasks.Get(task.ID)
	if got.Status != "done" || got.CompletedAt == nil {
		t.Errorf("B task after complete = status %q, completedAt %v; want done + set", got.Status, got.CompletedAt)
	}
}

// A note held open in an editor stashes a conflicting server version for the UI instead of
// auto-forking a conflicted copy; the user can then adopt the server version.
func TestHeldNoteConflictStashedNotForked(t *testing.T) {
	ts := newServer(t)
	token := register(t, ts.URL, "hold@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	note, _ := a.store.Notes.Create(store.CreateNoteInput{Title: "Shared"})
	a.engine.Sync()
	b.engine.Sync()

	// B opens the note in an editor.
	b.store.Notes.Hold(note.ID)

	// A's edit is newer; B's is older — a genuine conflict when B syncs.
	a.clk.t = base.Add(2 * time.Hour)
	a.store.Notes.Update(note.ID, store.UpdateNoteInput{Title: strPtr("A wins")})
	a.engine.Sync()
	b.clk.t = base.Add(1 * time.Hour)
	b.store.Notes.Update(note.ID, store.UpdateNoteInput{Title: strPtr("B edit")})
	b.engine.Sync()

	// No conflicted copy was forked, B's local edit is untouched, and the server version
	// is stashed for the UI.
	notes, _ := b.store.Notes.List()
	if len(notes) != 1 {
		t.Fatalf("held note should not fork a copy; got %d notes: %v", len(notes), titles(notes))
	}
	if got, _ := b.store.Notes.Get(note.ID); got.Title != "B edit" {
		t.Errorf("held local edit was clobbered: %q, want 'B edit'", got.Title)
	}
	pc := b.store.Notes.PendingConflict()
	if pc == nil || pc.Title != "A wins" {
		t.Fatalf("expected stashed server conflict 'A wins', got %+v", pc)
	}

	// Adopt the server version.
	if err := b.store.Notes.ResolveConflictAdopt(note.ID); err != nil {
		t.Fatalf("adopt: %v", err)
	}
	if got, _ := b.store.Notes.Get(note.ID); got.Title != "A wins" {
		t.Errorf("after adopt, title = %q, want 'A wins'", got.Title)
	}
	if b.store.Notes.PendingConflict() != nil {
		t.Error("conflict should be cleared after adopt")
	}
}

// When the held note is deleted on another device while it has local edits, the delete is
// stashed (not applied); the user can restore it, bringing it back to life.
func TestHeldNoteRemoteDeleteRestore(t *testing.T) {
	ts := newServer(t)
	token := register(t, ts.URL, "holddel@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	note, _ := a.store.Notes.Create(store.CreateNoteInput{Title: "Live"})
	a.engine.Sync()
	b.engine.Sync()

	b.store.Notes.Hold(note.ID)

	// A trashes the note (newer); B edits it (older) then syncs → conflict is a delete.
	a.clk.t = base.Add(2 * time.Hour)
	a.store.Notes.Trash(note.ID)
	a.engine.Sync()
	b.clk.t = base.Add(1 * time.Hour)
	b.store.Notes.Update(note.ID, store.UpdateNoteInput{Title: strPtr("B still editing")})
	b.engine.Sync()

	pc := b.store.Notes.PendingConflict()
	if pc == nil || pc.DeletingAt == nil {
		t.Fatalf("expected a stashed delete conflict, got %+v", pc)
	}
	// B's copy is still live and editable (the delete wasn't applied).
	if _, err := b.store.Notes.Get(note.ID); err != nil {
		t.Errorf("held note should stay live until resolved, err = %v", err)
	}

	// Restore resurrects the note.
	if err := b.store.Notes.ResolveConflictRestore(note.ID); err != nil {
		t.Fatalf("restore: %v", err)
	}
	got, err := b.store.Notes.Get(note.ID)
	if err != nil {
		t.Fatalf("note should be live after restore: %v", err)
	}
	if got.DeletingAt != nil || got.DeletedAt != nil {
		t.Errorf("restored note still marked deleted: %+v", got)
	}
	if b.store.Notes.PendingConflict() != nil {
		t.Error("conflict should be cleared after restore")
	}
}

func strPtr(s string) *string { return &s }
