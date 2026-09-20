package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPaletteOpenRelaysTheRef(t *testing.T) {
	surfaced := 0
	var name, payload string
	h := paletteOpenHandler(func() { surfaced++ }, func(n string, p []byte) { name, payload = n, string(p) })

	body := `{"kind":"note","id":"n1"}`
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, "/palette/open", strings.NewReader(body)))

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	if surfaced != 1 {
		t.Fatalf("surfaced %d times, want 1", surfaced)
	}
	if name != paletteOpenEvent || payload != body {
		t.Fatalf("emitted %q %q, want %q %q", name, payload, paletteOpenEvent, body)
	}
}

func TestPaletteOpenRejectsWhatIsNotARef(t *testing.T) {
	for _, tc := range []struct{ method, body string }{
		{http.MethodGet, `{"kind":"note","id":"n1"}`},
		{http.MethodPost, `not json`},
		{http.MethodPost, `{"id":"n1"}`},
		{http.MethodPost, `{"kind":"note","id":"` + strings.Repeat("x", paletteOpenMaxBytes) + `"}`},
	} {
		h := paletteOpenHandler(
			func() { t.Errorf("%s %.20q: surfaced the main window", tc.method, tc.body) },
			func(string, []byte) { t.Errorf("%s %.20q: emitted an event", tc.method, tc.body) },
		)
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest(tc.method, "/palette/open", strings.NewReader(tc.body)))
		if rec.Code < 400 {
			t.Errorf("%s %.20q: status = %d, want an error", tc.method, tc.body, rec.Code)
		}
	}
}
