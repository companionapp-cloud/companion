package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSafeExportName(t *testing.T) {
	cases := map[string]string{
		"Plan.pdf":               "Plan.pdf",
		"../../etc/passwd":       "etc passwd",
		"/abs/path.md":           "abs path.md",
		`a\b:c*d?"e<f>g|h.txt`:   "a b c d e f g h.txt",
		"..hidden":               "hidden",
		"  spaced   out .png ":   "spaced out .png",
		"":                       "Export",
		"...":                    "Export",
		"tab\tand\nnewline.html": "tab and newline.html",
	}
	for in, want := range cases {
		if got := safeExportName(in); got != want {
			t.Errorf("safeExportName(%q) = %q, want %q", in, got, want)
		}
	}
}

// A folder export never replaces a file that was already there, nor one it wrote itself.
func TestFreePathStepsAside(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "Plan.pdf"), []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := &exportSession{dir: dir, written: map[string]bool{}}
	if got := filepath.Base(s.freePath("Plan.pdf")); got != "Plan 2.pdf" {
		t.Errorf("first = %q, want Plan 2.pdf", got)
	}
	// Not on disk yet, but claimed by this export — and case-insensitively, as macOS is.
	if got := filepath.Base(s.freePath("plan 2.pdf")); got != "plan 2 2.pdf" {
		t.Errorf("second = %q, want plan 2 2.pdf", got)
	}
	if got := filepath.Base(s.freePath("Other.pdf")); got != "Other.pdf" {
		t.Errorf("unrelated = %q, want Other.pdf", got)
	}
}

func TestHandleWrite(t *testing.T) {
	dir := t.TempDir()
	s := newExportService(nil)
	s.sessions["folder"] = &exportSession{dir: dir, written: map[string]bool{}, touched: time.Now()}
	single := filepath.Join(dir, "Chosen.pdf")
	s.sessions["single"] = &exportSession{file: single, written: map[string]bool{}, touched: time.Now()}

	post := func(query, body string) int {
		rec := httptest.NewRecorder()
		s.handleWrite(rec, httptest.NewRequest(http.MethodPost, "/export/write?"+query, strings.NewReader(body)))
		return rec.Code
	}

	// A name can't climb out of the chosen folder.
	if code := post("token=folder&name=..%2F..%2Fescape.txt", "data"); code != http.StatusNoContent {
		t.Fatalf("folder write: %d", code)
	}
	if got, err := os.ReadFile(filepath.Join(dir, "escape.txt")); err != nil || string(got) != "data" {
		t.Errorf("expected the file inside the folder, got %q, %v", got, err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(filepath.Dir(dir)), "escape.txt")); err == nil {
		t.Error("the write escaped its folder")
	}

	// A single-file session writes to the path its panel returned, whatever name is sent.
	if code := post("token=single&name=ignored.pdf", "pdf"); code != http.StatusNoContent {
		t.Fatalf("single write: %d", code)
	}
	if got, _ := os.ReadFile(single); string(got) != "pdf" {
		t.Errorf("single file = %q", got)
	}

	if code := post("token=nope&name=x.txt", "x"); code != http.StatusNotFound {
		t.Errorf("unknown token: %d, want 404", code)
	}

	// No temp files left behind.
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".companion-export-") {
			t.Errorf("leftover temp file %s", e.Name())
		}
	}

	rec := httptest.NewRecorder()
	s.handleEnd(rec, httptest.NewRequest(http.MethodPost, "/export/end?token=folder", nil))
	if code := post("token=folder&name=late.txt", "x"); code != http.StatusNotFound {
		t.Errorf("write after end: %d, want 404", code)
	}
}
