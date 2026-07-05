package bridge

import (
	"encoding/json"
	"testing"

	"companion/core/domain"
	"companion/core/store"
)

// capturingHandler records events emitted by the core.
type capturingHandler struct{ events []string }

func (h *capturingHandler) OnEvent(name string, _ []byte) {
	h.events = append(h.events, name)
}

func (h *capturingHandler) count(name string) int {
	n := 0
	for _, e := range h.events {
		if e == name {
			n++
		}
	}
	return n
}

func newTestCore(t *testing.T) (*Core, *capturingHandler) {
	t.Helper()
	st, err := store.Open(":memory:", domain.SystemClock{})
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	c := New(st)
	h := &capturingHandler{}
	c.SetEventHandler(h)
	return c, h
}

func TestInvokeVersion(t *testing.T) {
	c, _ := newTestCore(t)
	out, err := c.Invoke("core.version", nil)
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	var got map[string]string
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got["version"] != Version {
		t.Errorf("version = %q, want %q", got["version"], Version)
	}
}

func TestInvokeUnknownMethod(t *testing.T) {
	c, _ := newTestCore(t)
	if _, err := c.Invoke("nope.nope", nil); err == nil {
		t.Error("expected error for unknown method")
	}
}

func TestNotesCRUDOverBridge(t *testing.T) {
	c, h := newTestCore(t)

	// Create
	out, err := c.Invoke("notes.create", []byte(`{"title":"First","contentMd":"body"}`))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	var created domain.Note
	if err := json.Unmarshal(out, &created); err != nil {
		t.Fatalf("decode created: %v", err)
	}
	if created.ID == "" || created.Title != "First" {
		t.Fatalf("unexpected created note: %+v", created)
	}

	// List
	out, err = c.Invoke("notes.list", nil)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	var list []domain.Note
	if err := json.Unmarshal(out, &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("list len = %d, want 1", len(list))
	}

	// Update
	upd := `{"id":"` + created.ID + `","title":"Renamed"}`
	out, err = c.Invoke("notes.update", []byte(upd))
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	var updated domain.Note
	json.Unmarshal(out, &updated)
	if updated.Title != "Renamed" {
		t.Errorf("updated title = %q, want Renamed", updated.Title)
	}

	// Get
	out, err = c.Invoke("notes.get", []byte(`{"id":"`+created.ID+`"}`))
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	var fetched domain.Note
	json.Unmarshal(out, &fetched)
	if fetched.Title != "Renamed" {
		t.Errorf("fetched title = %q, want Renamed", fetched.Title)
	}

	// Delete
	if _, err := c.Invoke("notes.delete", []byte(`{"id":"`+created.ID+`"}`)); err != nil {
		t.Fatalf("delete: %v", err)
	}
	out, _ = c.Invoke("notes.list", nil)
	json.Unmarshal(out, &list)
	if len(list) != 0 {
		t.Errorf("list after delete len = %d, want 0", len(list))
	}

	// Each mutation (create, update, delete) emits both the legacy notes.changed and
	// the generic data.changed (PLAN §5.4).
	if got := h.count("notes.changed"); got != 3 {
		t.Errorf("notes.changed emitted %d times, want 3: %v", got, h.events)
	}
	if got := h.count("data.changed"); got != 3 {
		t.Errorf("data.changed emitted %d times, want 3: %v", got, h.events)
	}
}

func TestNotesGetMissingOverBridge(t *testing.T) {
	c, _ := newTestCore(t)
	if _, err := c.Invoke("notes.get", []byte(`{"id":"missing"}`)); err == nil {
		t.Error("expected error for missing note")
	}
}
