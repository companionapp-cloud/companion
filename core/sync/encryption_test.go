//go:build !js

package sync_test

import (
	"strings"
	"testing"

	"companion/core/crypto"
	"companion/core/store"
	syncpkg "companion/core/sync"
	"companion/core/sync/protocol"
)

// captureTransport is a minimal in-memory stand-in for the sync server: Push records the exact
// wire rows it received (so a test can assert they are ciphertext), and Pull replays them to
// another engine (a second device). It assigns a monotonic server_seq like the real server.
type captureTransport struct {
	rows []protocol.PullChange
}

func (c *captureTransport) Push(changes []protocol.PushChange) (*protocol.PushResponse, error) {
	res := make([]protocol.PushResult, 0, len(changes))
	for _, ch := range changes {
		seq := int64(len(c.rows) + 1)
		c.rows = append(c.rows, protocol.PullChange{EntityType: ch.EntityType, Row: ch.Row, ServerSeq: seq})
		res = append(res, protocol.PushResult{ID: ch.ID, Status: protocol.StatusAccepted, Version: ch.BaseVersion + 1})
	}
	return &protocol.PushResponse{Results: res}, nil
}

func (c *captureTransport) Pull(cursor int64, limit int) (*protocol.PullResponse, error) {
	out := &protocol.PullResponse{NextCursor: cursor}
	for _, r := range c.rows {
		if r.ServerSeq > cursor {
			out.Changes = append(out.Changes, r)
			out.NextCursor = r.ServerSeq
		}
	}
	return out, nil
}

// TestEncryptedPushIsCiphertextAndDecryptsOnAnotherDevice is the end-to-end guarantee: content
// leaves device A as ciphertext (the server/transport never sees plaintext), and device B, holding
// the same master key, recovers it exactly.
func TestEncryptedPushIsCiphertextAndDecryptsOnAnotherDevice(t *testing.T) {
	master, _ := crypto.NewMasterKey()
	cipher := crypto.NewCipher(master)
	transport := &captureTransport{}

	// Device A: create a note, sync with encryption on.
	a, err := store.Open(":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if err := a.EnsureSyncState("device-a"); err != nil {
		t.Fatal(err)
	}
	note, err := a.Notes.Create(store.CreateNoteInput{Title: "Dentist appointment", ContentMD: "# 2pm Tuesday"})
	if err != nil {
		t.Fatal(err)
	}

	engA := syncpkg.New(a, transport, nil)
	engA.SetCipher(cipher)
	if err := engA.Sync(); err != nil {
		t.Fatalf("device A sync: %v", err)
	}

	// The wire row the transport captured must not contain plaintext content.
	if len(transport.rows) == 0 {
		t.Fatal("expected a pushed row")
	}
	var found bool
	for _, r := range transport.rows {
		if r.EntityType != protocol.EntityNote {
			continue
		}
		found = true
		wire := string(r.Row)
		if strings.Contains(wire, "Dentist") || strings.Contains(wire, "Tuesday") {
			t.Fatalf("plaintext leaked onto the wire: %s", wire)
		}
		if !strings.Contains(wire, "enc$v1$") {
			t.Fatalf("expected encrypted envelope on the wire, got: %s", wire)
		}
		// The row id stays plaintext so the server can key/conflict on it.
		if !strings.Contains(wire, note.ID) {
			t.Fatal("row id must remain plaintext on the wire")
		}
	}
	if !found {
		t.Fatal("no note row captured")
	}

	// Device B: fresh store, same key. Pull should decrypt back to the original plaintext.
	b, err := store.Open(":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	if err := b.EnsureSyncState("device-b"); err != nil {
		t.Fatal(err)
	}
	engB := syncpkg.New(b, transport, nil)
	engB.SetCipher(cipher)
	if err := engB.Sync(); err != nil {
		t.Fatalf("device B sync: %v", err)
	}

	got, err := b.Notes.Get(note.ID)
	if err != nil {
		t.Fatalf("device B get note: %v", err)
	}
	if got.Title != "Dentist appointment" || got.ContentMD != "# 2pm Tuesday" {
		t.Fatalf("device B did not decrypt correctly: title=%q content=%q", got.Title, got.ContentMD)
	}
}

// TestLegacyPlaintextRowStillSyncs proves a cipher-enabled device can still read a pre-encryption
// (plaintext) row from the server — the migration compatibility guarantee.
func TestLegacyPlaintextRowStillSyncs(t *testing.T) {
	master, _ := crypto.NewMasterKey()
	transport := &captureTransport{}

	// Device A pushes WITHOUT a cipher (simulating a legacy client / pre-migration row).
	a, err := store.Open(":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	a.EnsureSyncState("legacy")
	note, err := a.Notes.Create(store.CreateNoteInput{Title: "Old note", ContentMD: "plain"})
	if err != nil {
		t.Fatal(err)
	}
	engA := syncpkg.New(a, transport, nil) // no SetCipher → plaintext push
	if err := engA.Sync(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(transport.rows[0].Row), "Old note") {
		t.Fatal("legacy push should be plaintext")
	}

	// Device B has encryption enabled but must still read the legacy plaintext row untouched.
	b, err := store.Open(":memory:", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	b.EnsureSyncState("device-b")
	engB := syncpkg.New(b, transport, nil)
	engB.SetCipher(crypto.NewCipher(master))
	if err := engB.Sync(); err != nil {
		t.Fatalf("device B sync: %v", err)
	}
	got, err := b.Notes.Get(note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "Old note" {
		t.Fatalf("legacy row not read correctly: %q", got.Title)
	}
}
