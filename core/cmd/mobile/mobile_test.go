//go:build !js

package mobile

import (
	"encoding/json"
	"testing"
)

// capturingHandler records event names emitted to the (gomobile) EventHandler.
type capturingHandler struct{ events []string }

func (h *capturingHandler) OnEvent(name string, _ []byte) { h.events = append(h.events, name) }

func TestMobileCoreInvoke(t *testing.T) {
	core, err := New(":memory:")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer core.Close()

	h := &capturingHandler{}
	core.SetEventHandler(h)

	// version
	out, err := core.Invoke("core.version", nil)
	if err != nil {
		t.Fatalf("version: %v", err)
	}
	if len(out) == 0 {
		t.Fatal("empty version result")
	}

	// create + list round-trip through the bound API
	out, err = core.Invoke("notes.create", []byte(`{"title":"On device","contentMd":"hi"}`))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	var created struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	if err := json.Unmarshal(out, &created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if created.ID == "" || created.Title != "On device" {
		t.Fatalf("unexpected create result: %s", out)
	}

	out, _ = core.Invoke("notes.list", nil)
	var list []map[string]any
	if err := json.Unmarshal(out, &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("list len = %d, want 1", len(list))
	}

	// One create emits both notes.changed (legacy) and data.changed (PLAN §5.4).
	if len(h.events) != 2 || h.events[0] != "notes.changed" || h.events[1] != "data.changed" {
		t.Errorf("events = %v, want [notes.changed data.changed]", h.events)
	}
}

func TestMobileCoreClearHandler(t *testing.T) {
	core, err := New(":memory:")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer core.Close()
	core.SetEventHandler(&capturingHandler{})
	core.SetEventHandler(nil) // must not panic
	if _, err := core.Invoke("notes.create", []byte(`{"title":"x"}`)); err != nil {
		t.Fatalf("create after clearing handler: %v", err)
	}
}
