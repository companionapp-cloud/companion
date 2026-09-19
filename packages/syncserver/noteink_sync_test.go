package syncserver

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"companion/core/crypto"
	"companion/core/store"
)

const (
	syncInkA = "0190f5a0-0000-7000-8000-0000000000a1"
	syncInkB = "0190f5a0-0000-7000-8000-0000000000b2"
)

// Two devices drawing on the same note merge per ink group, the server only ever holds
// ciphertext for the strokes and their text anchor, and a concurrent edit of the same group
// is last-writer-wins with no forked copy (PLAN-drawing.md).
func TestNoteInkSyncMergesPerGroupAndStaysEncrypted(t *testing.T) {
	ts, srv := newServerAPI(t)
	token := register(t, ts.URL, "ink@b.co", "password")
	cipher := crypto.NewCipher(mustKey(t))
	a := newClient(t, ts.URL, token, "devA")
	a.engine.SetCipher(cipher)
	b := newClient(t, ts.URL, token, "devB")
	b.engine.SetCipher(cipher)

	note, err := a.store.Notes.Create(store.CreateNoteInput{Title: "Meeting", ContentMD: "Ship the quarterly report"})
	if err != nil {
		t.Fatalf("create note: %v", err)
	}
	if err := a.engine.Sync(); err != nil {
		t.Fatalf("A sync: %v", err)
	}
	if err := b.engine.Sync(); err != nil {
		t.Fatalf("B sync: %v", err)
	}

	// Each device draws its own group on the same note.
	a.clk.t = base.Add(time.Hour)
	b.clk.t = base.Add(time.Hour)
	if _, err := a.store.NoteInk.UpsertMany(note.ID, []store.NoteInkInput{
		{ID: syncInkA, Data: json.RawMessage(`{"v":1,"anchor":{"before":"Ship the ","after":"quarterly report"},"strokes":["circle"]}`)},
	}); err != nil {
		t.Fatalf("A draw: %v", err)
	}
	if _, err := b.store.NoteInk.UpsertMany(note.ID, []store.NoteInkInput{
		{ID: syncInkB, Data: json.RawMessage(`{"v":1,"strokes":["underline"]}`)},
	}); err != nil {
		t.Fatalf("B draw: %v", err)
	}
	for _, c := range []*client{a, b, a} {
		if err := c.engine.Sync(); err != nil {
			t.Fatalf("sync: %v", err)
		}
	}
	for name, c := range map[string]*client{"A": a, "B": b} {
		groups, err := c.store.NoteInk.ListForNote(note.ID)
		if err != nil || len(groups) != 2 {
			t.Fatalf("%s groups = %+v (err %v)", name, groups, err)
		}
		for _, g := range groups {
			if g.Dirty || g.Version == 0 {
				t.Errorf("%s: synced group should be clean with a version: %+v", name, g)
			}
		}
	}
	got, _ := b.store.NoteInk.GetAny(syncInkA)
	if !strings.Contains(string(got.Data), `"circle"`) || !strings.Contains(string(got.Data), "quarterly") {
		t.Fatalf("B did not decrypt A's group: %s", got.Data)
	}

	// The server stores the payload as an envelope: neither the strokes nor the quoted note
	// text is readable there. The note id stays a plain column for the purge cascade.
	rows, err := srv.query(`SELECT note_id, data_json FROM note_ink;`)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for rows.Next() {
		var noteID, data string
		if err := rows.Scan(&noteID, &data); err != nil {
			t.Fatal(err)
		}
		n++
		if noteID != note.ID {
			t.Errorf("server note_id = %q, want %q", noteID, note.ID)
		}
		for _, secret := range []string{"circle", "underline", "quarterly", "strokes"} {
			if strings.Contains(data, secret) {
				t.Errorf("server can read %q in note ink: %s", secret, data)
			}
		}
		if !strings.Contains(data, "enc$v1$") {
			t.Errorf("server ink payload is not an envelope: %s", data)
		}
	}
	rows.Close()
	if n != 2 {
		t.Fatalf("server holds %d ink rows, want 2", n)
	}

	// The same group edited on both devices: the newer write wins, and nothing forks.
	a.clk.t = base.Add(2 * time.Hour)
	b.clk.t = base.Add(3 * time.Hour)
	if _, err := a.store.NoteInk.UpsertMany(note.ID, []store.NoteInkInput{{ID: syncInkA, Data: json.RawMessage(`{"v":1,"strokes":["older"]}`)}}); err != nil {
		t.Fatalf("A edit: %v", err)
	}
	if _, err := b.store.NoteInk.UpsertMany(note.ID, []store.NoteInkInput{{ID: syncInkA, Data: json.RawMessage(`{"v":1,"strokes":["newer"]}`)}}); err != nil {
		t.Fatalf("B edit: %v", err)
	}
	for _, c := range []*client{a, b, a} {
		if err := c.engine.Sync(); err != nil {
			t.Fatalf("sync: %v", err)
		}
	}
	for name, c := range map[string]*client{"A": a, "B": b} {
		groups, _ := c.store.NoteInk.ListForNote(note.ID)
		if len(groups) != 2 {
			t.Fatalf("%s: same-group conflict forked a copy: %d groups", name, len(groups))
		}
		g, _ := c.store.NoteInk.GetAny(syncInkA)
		if !strings.Contains(string(g.Data), "newer") {
			t.Fatalf("%s: newer write should win, got %s", name, g.Data)
		}
	}
}

// When a trashed note's retention elapses, the server's collector tombstones its ink too.
func TestNoteInkPurgedWithItsNote(t *testing.T) {
	ts, srv := newServerAPI(t)
	token := register(t, ts.URL, "inkpurge@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	note, err := a.store.Notes.Create(store.CreateNoteInput{Title: "Doodles"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := a.store.NoteInk.UpsertMany(note.ID, []store.NoteInkInput{
		{ID: syncInkA, Data: json.RawMessage(`{"v":1}`)},
		{ID: syncInkB, Data: json.RawMessage(`{"v":1}`)},
	}); err != nil {
		t.Fatalf("draw: %v", err)
	}
	if err := a.store.Notes.Trash(note.ID); err != nil {
		t.Fatalf("trash: %v", err)
	}
	for _, c := range []*client{a, b} {
		if err := c.engine.Sync(); err != nil {
			t.Fatalf("sync: %v", err)
		}
	}
	if groups, _ := b.store.NoteInk.ListForNote(note.ID); len(groups) != 2 {
		t.Fatalf("a trashed note keeps its ink until purge, B has %d groups", len(groups))
	}

	srv.clock = &testClock{t: base.Add(store.TrashRetention + time.Hour)}
	if n, err := srv.PurgeExpired(); err != nil || n != 1 {
		t.Fatalf("purge = %d (err %v)", n, err)
	}
	for name, c := range map[string]*client{"A": a, "B": b} {
		if err := c.engine.Sync(); err != nil {
			t.Fatalf("%s sync: %v", name, err)
		}
		if groups, _ := c.store.NoteInk.ListForNote(note.ID); len(groups) != 0 {
			t.Fatalf("%s: ink should be tombstoned with its note, got %d groups", name, len(groups))
		}
	}
}
