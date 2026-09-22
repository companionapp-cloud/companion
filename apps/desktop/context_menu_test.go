package main

import (
	"encoding/json"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func TestAddContextItems(t *testing.T) {
	// The shape packages/app/src/contextMenu.ts posts.
	raw := `[
		{"id":"0","label":"Open in New Tab"},
		{"separator":true},
		{"label":"Move to Area","children":[{"id":"2.0","label":"Work","checked":true},{"id":"2.1","label":"Home"}]},
		{"id":"3","label":"Delete","enabled":false}
	]`
	var items []contextMenuItem
	if err := json.Unmarshal([]byte(raw), &items); err != nil {
		t.Fatal(err)
	}
	menu := application.NewMenu()
	addContextItems(menu, items, func(string) {})

	if got := menu.ItemAt(0).Label(); got != "Open in New Tab" {
		t.Errorf("item 0 = %q", got)
	}
	if !menu.ItemAt(1).IsSeparator() {
		t.Error("item 1 should be a separator")
	}
	sub := menu.ItemAt(2).GetSubmenu()
	if sub == nil || sub.ItemAt(0).Label() != "Work" || !sub.ItemAt(0).Checked() || sub.ItemAt(1).Checked() {
		t.Error("submenu should hold Work (checked) and Home")
	}
	if menu.ItemAt(3).Enabled() {
		t.Error("Delete should be disabled")
	}
}
