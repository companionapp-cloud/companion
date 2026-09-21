package export

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSegment(t *testing.T) {
	cases := map[string]string{
		"Plan":                  "Plan",
		"a/b\\c:d*e?f\"g<h>i|j": "a b c d e f g h i j",
		"../../etc/passwd":      "etc passwd",
		"..":                    "Untitled",
		"  .hidden.  ":          "hidden",
		"tab\tnew\nline":        "tab new line",
		"":                      "Untitled",
		"日本語のノート":               "日本語のノート",
	}
	for in, want := range cases {
		if got := Segment(in, "Untitled"); got != want {
			t.Errorf("Segment(%q) = %q, want %q", in, got, want)
		}
	}
	if got := Segment(strings.Repeat("x", 300), "Untitled"); len([]rune(got)) != 120 {
		t.Errorf("long title kept %d runes", len([]rune(got)))
	}
}

func TestFrontMatter(t *testing.T) {
	got := frontMatter([]field{
		{"title", "Yes"},
		{"status", "open"},
		{"tricky", `a: "b" #c`},
		{"deadline", "2026-10-01"},
		{"empty", ""},
		{"none", []string{}},
		{"tags", []string{"work", "on"}},
		{"vip", true},
		{"age", float64(36)},
		{"title", "shadowed"},
		{"odd key", "v"},
	})
	want := "---\ntitle: \"Yes\"\nstatus: open\ntricky: \"a: \\\"b\\\" #c\"\ndeadline: 2026-10-01\ntags:\n  - work\n  - \"on\"\nvip: true\nage: 36\n\"odd key\": v\n---\n\n"
	if got != want {
		t.Errorf("front matter =\n%s\nwant\n%s", got, want)
	}
}

func TestYAMLDate(t *testing.T) {
	loc := time.FixedZone("ADT", -3*3600)
	midnight := time.Date(2026, 10, 1, 0, 0, 0, 0, loc)
	morning := time.Date(2026, 10, 1, 9, 30, 0, 0, loc)
	if got := yamlDate(&midnight, loc); got != "2026-10-01" {
		t.Errorf("local midnight = %q", got)
	}
	if got := yamlDate(&morning, loc); got != "2026-10-01T12:30:00.000Z" {
		t.Errorf("with a time = %q", got)
	}
	if got := yamlDate(nil, loc); got != "" {
		t.Errorf("nil = %q", got)
	}
}

func TestDiff(t *testing.T) {
	a := File{Path: "Notes/A.md", Content: []byte("a"), EntityType: "note", EntityID: "1"}
	b := File{Path: "Notes/B.md", Content: []byte("b"), EntityType: "note", EntityID: "2"}
	manifest := []ManifestEntry{
		{Path: "Notes/A.md", SHA: a.SHA(), EntityType: "note", EntityID: "1"},
		{Path: "Notes/B.md", SHA: "stale", EntityType: "note", EntityID: "2"},
		{Path: "Notes/Gone.md", SHA: "x", EntityType: "note", EntityID: "3"},
	}
	c := File{Path: "Notes/C.md", Content: []byte("c")}
	changes := Diff(manifest, []File{a, b, c})
	var got []string
	for _, ch := range changes {
		mark := "M"
		if ch.Deleted() {
			mark = "D"
		} else if ch.Added {
			mark = "A"
		}
		got = append(got, mark+" "+ch.Path)
	}
	// Unchanged A is absent; deletes come first.
	if want := "D Notes/Gone.md|M Notes/B.md|A Notes/C.md"; strings.Join(got, "|") != want {
		t.Errorf("changes = %v, want %s", got, want)
	}
	if s := Summarize(changes); s != (Summary{Added: 1, Updated: 1, Removed: 1}) {
		t.Errorf("summary = %+v", s)
	}
	if rebuilt := Diff(nil, []File{a, b}); len(rebuilt) != 2 || !rebuilt[0].Added {
		t.Errorf("an empty manifest should rewrite everything: %+v", rebuilt)
	}
}

func TestFolderSinkStaysInside(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(filepath.Dir(root), "escaped.md")
	sink := FolderSink{Root: root}
	for _, path := range []string{"../escaped.md", "Notes/../../escaped.md"} {
		if _, err := sink.Apply([]Change{{Path: path, Content: []byte("x")}}); err == nil {
			t.Errorf("%q should be refused", path)
		}
	}
	if _, err := os.Stat(outside); err == nil {
		t.Error("a write escaped the export folder")
	}

	// Writes make their folders; deletes prune the folders they empty, but never the root or a
	// folder that still holds something of the user's.
	if _, err := sink.Apply([]Change{{Path: "Areas/Work/Notes/A.md", Content: []byte("a")}, {Path: "Keep/B.md", Content: []byte("b")}}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "Keep", "mine.txt"), []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := sink.Apply([]Change{{Path: "Areas/Work/Notes/A.md"}, {Path: "Keep/B.md"}, {Path: "Never/There.md"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "Areas")); !os.IsNotExist(err) {
		t.Error("emptied folders should be pruned")
	}
	if _, err := os.Stat(filepath.Join(root, "Keep", "mine.txt")); err != nil {
		t.Error("the user's own file must survive")
	}
	if _, err := os.Stat(root); err != nil {
		t.Error("the root must survive")
	}
}
