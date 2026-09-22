package syncserver

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"
	"time"

	"companion/core/domain"
	"companion/core/store"
)

// A Danger Zone clear (core/store/cleardata.go) blanks the text a tombstone keeps. The server
// validates rows on push, tombstones included, so every blanked row must still pass: a
// plaintext account's archetyped note (props checked against the type), a document (a
// filename is required), a repeating task (its rule and reminders are checked). One rejected
// row fails the whole push and wedges sync, so this runs a clear of everything through the real
// server and checks the push goes through, the server's copies are blank, the file's bytes are
// gone, and a second device ends up empty.
func TestClearAllDataSyncsAsBlankTombstones(t *testing.T) {
	ts, api := newServerAPI(t)
	token := register(t, ts.URL, "clear@b.co", "password")
	a := newClient(t, ts.URL, token, "devA")
	b := newClient(t, ts.URL, token, "devB")

	typ, err := a.store.ObjectTypes.Create(store.CreateObjectTypeInput{
		Name:       "Book",
		AppliesTo:  "note",
		SchemaJSON: json.RawMessage(`{"fields":[{"key":"author","type":"text","required":true}]}`),
	})
	if err != nil {
		t.Fatalf("create type: %v", err)
	}
	content := []byte("scanned receipt")
	sum := sha256.Sum256(content)
	sha := hex.EncodeToString(sum[:])
	if status, _ := blobReq(t, "PUT", ts.URL, token, sha, content); status != 200 {
		t.Fatalf("blob upload = %d", status)
	}
	doc, err := a.store.Documents.Create(store.CreateDocumentInput{Filename: "receipt.pdf", Size: int64(len(content)), SHA256: sha})
	if err != nil {
		t.Fatal(err)
	}
	if err := a.store.Documents.MarkUploaded(doc.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := a.store.Notes.Create(store.CreateNoteInput{
		Title: "Dune", ContentMD: "loved it ![[doc:" + doc.ID + "]]",
		ObjectTypeID: &typ.ID, Props: json.RawMessage(`{"author":"Herbert"}`),
	}); err != nil {
		t.Fatalf("create note: %v", err)
	}
	due := base.Add(24 * time.Hour)
	if _, err := a.store.Tasks.Create(store.CreateTaskInput{
		Title: "Water plants", NotesMD: "the fern", DueAt: &due,
		RepeatRule: strPtr("FREQ=WEEKLY"), Reminders: []domain.Reminder{{Before: "PT1H"}},
	}); err != nil {
		t.Fatalf("create task: %v", err)
	}
	board, _ := a.store.Canvases.Create(store.CreateCanvasInput{Name: "Plans"})
	nodes, err := a.store.CanvasNodes.UpsertMany(board.ID, []store.CanvasNodeInput{
		{Kind: domain.CanvasNodeText, Width: 200, Height: 100, Data: json.RawMessage(`{"text":"secret"}`)},
		{Kind: domain.CanvasNodeText, Width: 200, Height: 100, Data: json.RawMessage(`{"text":"plan"}`)},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.store.CanvasEdges.UpsertMany(board.ID, []store.CanvasEdgeInput{{FromNodeID: nodes[0].ID, ToNodeID: nodes[1].ID, Label: "why"}}); err != nil {
		t.Fatal(err)
	}
	chat, _ := a.store.Chats.Create("Taxes", nil)
	if _, err := a.store.ChatMessages.Append(chat.ID, domain.ChatRoleUser, "my salary is", nil, nil); err != nil {
		t.Fatal(err)
	}
	area, _ := a.store.Areas.Create(store.CreateAreaInput{Name: "Health", DescriptionMd: "goals"})
	proj, _ := a.store.Projects.Create(store.CreateProjectInput{AreaID: area.ID, Name: "Run"})
	list, _ := a.store.Lists.Create(store.CreateListInput{ProjectID: proj.ID, Name: "Week 1"})
	if _, err := a.store.ListItems.AddHeading(list.ID, "Monday"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.store.CalendarFeeds.Create(store.CreateFeedInput{Name: "Work", URL: "https://example.com/private-token.ics"}); err != nil {
		t.Fatal(err)
	}

	for _, c := range []*client{a, b} {
		if err := c.engine.Sync(); err != nil {
			t.Fatalf("initial sync: %v", err)
		}
	}
	if sum, _ := b.store.DataSummary(); sum.Notes != 1 || sum.Tasks == 0 || sum.Canvases != 1 || sum.Files != 1 {
		t.Fatalf("B before the clear = %+v", sum)
	}

	a.clk.t = base.Add(48 * time.Hour)
	if _, err := a.store.ClearData(store.AllDataKinds); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if err := a.engine.Sync(); err != nil {
		t.Fatalf("pushing the clear: %v", err)
	}
	if err := b.engine.Sync(); err != nil {
		t.Fatalf("B pulling the clear: %v", err)
	}

	for name, c := range map[string]*client{"A": a, "B": b} {
		sum, err := c.store.DataSummary()
		if err != nil {
			t.Fatal(err)
		}
		if *sum != (store.DataSummary{}) {
			t.Errorf("%s after the clear = %+v, want nothing left", name, sum)
		}
	}
	// Nothing is left waiting to push, so nothing was rejected.
	if n, err := a.store.Notes.Dirty(); err != nil || len(n) != 0 {
		t.Errorf("A still has %d dirty notes (err %v)", len(n), err)
	}

	uid := userIDForToken(t, api, token)
	for _, q := range []string{
		`SELECT count(*) FROM notes WHERE user_id = ? AND (deleted_at IS NULL OR title <> '' OR content_md <> '' OR props_json <> '{}')`,
		`SELECT count(*) FROM tasks WHERE user_id = ? AND (deleted_at IS NULL OR title <> '' OR notes_md <> '')`,
		`SELECT count(*) FROM canvases WHERE user_id = ? AND (deleted_at IS NULL OR name <> '')`,
		`SELECT count(*) FROM canvas_nodes WHERE user_id = ? AND (deleted_at IS NULL OR data_json <> '{}')`,
		`SELECT count(*) FROM chat_messages WHERE user_id = ? AND (deleted_at IS NULL OR text <> '')`,
		`SELECT count(*) FROM areas WHERE user_id = ? AND (deleted_at IS NULL OR name <> '' OR description_md <> '')`,
		`SELECT count(*) FROM calendar_feeds WHERE user_id = ? AND (deleted_at IS NULL OR url <> '')`,
		`SELECT count(*) FROM documents WHERE user_id = ? AND (deleted_at IS NULL OR filename = 'receipt.pdf')`,
	} {
		var n int
		if err := api.queryRow(q+`;`, uid).Scan(&n); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		if n != 0 {
			t.Errorf("server still holds %d row(s) for: %s", n, q)
		}
	}
	// The pushed document tombstone takes its bytes with it.
	if _, err := api.blobs.Get(context.Background(), blobKey(uid, sha)); err != errBlobNotFound {
		t.Errorf("the cleared file's bytes are still on the server (err %v)", err)
	}
}
