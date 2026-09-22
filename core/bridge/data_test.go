package bridge

import (
	"bytes"
	"encoding/json"
	"testing"

	"companion/core/domain"
	"companion/core/store"
)

func summary(t *testing.T, c *Core) store.DataSummary {
	t.Helper()
	out, err := c.Invoke("data.summary", nil)
	if err != nil {
		t.Fatalf("data.summary: %v", err)
	}
	var sum store.DataSummary
	if err := json.Unmarshal(out, &sum); err != nil {
		t.Fatalf("decode summary: %v", err)
	}
	return sum
}

// Clearing notes deletes them and the bytes of the files only they used, tells the screens to
// reload, and asks the shell for a sync so the deletion reaches the server now.
func TestDataClearNotes(t *testing.T) {
	c, blobs := coreWithBlobs(t)
	h := &capturingHandler{}
	c.SetEventHandler(h)

	sha, size, err := blobs.Put(bytes.NewReader([]byte("attached bytes")))
	if err != nil {
		t.Fatal(err)
	}
	doc, err := c.store.Documents.Create(store.CreateDocumentInput{Filename: "a.txt", Size: size, SHA256: sha})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Invoke("notes.create", mustJSON(map[string]string{"title": "Private", "contentMd": "![[doc:" + doc.ID + "]]"})); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Invoke("tasks.create", mustJSON(map[string]string{"title": "Stays"})); err != nil {
		t.Fatal(err)
	}
	if got := summary(t, c); got.Notes != 1 || got.Tasks != 1 || got.Files != 1 {
		t.Fatalf("summary before = %+v", got)
	}

	out, err := c.Invoke("data.clear", mustJSON(map[string]any{"kinds": []string{"notes"}}))
	if err != nil {
		t.Fatalf("data.clear: %v", err)
	}
	var res struct {
		Cleared map[string]int64 `json:"cleared"`
	}
	if err := json.Unmarshal(out, &res); err != nil {
		t.Fatal(err)
	}
	if res.Cleared["notes"] != 1 {
		t.Errorf("cleared = %v", res.Cleared)
	}
	if got := summary(t, c); got.Notes != 0 || got.Files != 0 || got.Tasks != 1 {
		t.Errorf("summary after = %+v, want notes and their file gone, the task kept", got)
	}
	if has, _ := blobs.Has(sha); has {
		t.Error("the file's bytes should be gone")
	}
	for _, ev := range []string{notesChangedEvent, documentsChangedEvent, dataChangedEvent, syncRequestedEvent} {
		if h.count(ev) == 0 {
			t.Errorf("no %s event", ev)
		}
	}
	if h.count(canvasesChangedEvent) != 0 {
		t.Error("clearing notes shouldn't reload canvases")
	}
}

// Clearing everything also forgets the device secrets the deleted rows pointed at.
func TestDataClearAllDropsSecrets(t *testing.T) {
	c, _ := newTestCore(t)
	secrets := mapSecrets{"agent/key": "sk-live", "caldav/pw": "hunter2", "keep": "unrelated"}
	c.SetSecretStore(secrets)

	keyRef, pwRef := "agent/key", "caldav/pw"
	if _, err := c.store.Agents.Create(store.CreateAgentInput{Name: "Claude", Runtime: domain.RuntimeAnthropicAPI, APIKeyRef: &keyRef}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.store.CalendarAccounts.Create(store.CreateAccountInput{Name: "iCloud", ServerURL: "https://caldav.icloud.com", Username: "me", CredentialRef: &pwRef}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Invoke("chats.create", mustJSON(map[string]string{"title": "hi"})); err != nil {
		t.Fatal(err)
	}

	if _, err := c.Invoke("data.clear", mustJSON(map[string]bool{"all": true})); err != nil {
		t.Fatalf("data.clear all: %v", err)
	}
	if got := summary(t, c); got != (store.DataSummary{}) {
		t.Errorf("summary after = %+v, want zero", got)
	}
	if _, ok := secrets[keyRef]; ok {
		t.Error("the agent's API key is still in the secret store")
	}
	if _, ok := secrets[pwRef]; ok {
		t.Error("the calendar password is still in the secret store")
	}
	if secrets["keep"] != "unrelated" {
		t.Error("an unrelated secret was deleted")
	}
}

func TestDataClearRejectsBadRequests(t *testing.T) {
	c, _ := newTestCore(t)
	if _, err := c.Invoke("notes.create", mustJSON(map[string]string{"title": "safe"})); err != nil {
		t.Fatal(err)
	}
	for _, payload := range []string{`{}`, `{"kinds":[]}`, `{"kinds":["notes","everything"]}`} {
		if _, err := c.Invoke("data.clear", []byte(payload)); err == nil {
			t.Errorf("data.clear %s: expected an error", payload)
		}
	}
	if got := summary(t, c); got.Notes != 1 {
		t.Errorf("a rejected clear touched data: %+v", got)
	}
}
