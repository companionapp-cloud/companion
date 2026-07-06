//go:build !js

package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestHtmlToText checks the extractor lifts the title, drops script/style, and yields clean
// readable text.
func TestHtmlToText(t *testing.T) {
	page := `<html><head><title>My &amp; Page</title><style>.x{color:red}</style></head>
	<body><script>var a=1;</script><h1>Hello</h1><p>First&nbsp;para with <a href="/x">a link</a>.</p><ul><li>one</li><li>two</li></ul></body></html>`
	title, text := htmlToText(page)
	if title != "My & Page" {
		t.Errorf("title = %q", title)
	}
	if strings.Contains(text, "var a=1") || strings.Contains(text, "color:red") {
		t.Errorf("script/style leaked into text: %q", text)
	}
	for _, want := range []string{"Hello", "First para with a link.", "one", "two"} {
		if !strings.Contains(text, want) {
			t.Errorf("text missing %q; got %q", want, text)
		}
	}
}

// TestReadFromInternet exercises the tool end to end against a local HTTP server.
func TestReadFromInternet(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(`<title>Doc</title><body><p>The answer is 42.</p></body>`))
	}))
	defer srv.Close()

	out, err := readFromInternet(context.Background(), json.RawMessage(`{"url":"`+srv.URL+`"}`))
	if err != nil {
		t.Fatalf("readFromInternet: %v", err)
	}
	var got struct {
		Title string `json:"title"`
		Text  string `json:"text"`
	}
	json.Unmarshal([]byte(out), &got)
	if got.Title != "Doc" || !strings.Contains(got.Text, "The answer is 42.") {
		t.Errorf("unexpected result: %+v", got)
	}

	// A non-http scheme is rejected before any request.
	if _, err := readFromInternet(context.Background(), json.RawMessage(`{"url":"ftp://x/y"}`)); err == nil {
		t.Error("expected rejection of non-http url")
	}
}

// TestParseGoogleResults checks extraction of external links from a Google-style results
// page, skipping Google's own hosts and deduping.
func TestParseGoogleResults(t *testing.T) {
	body := `
	<a href="/url?q=https://example.com/a&sa=U">A</a>
	<a href="/url?q=https://support.google.com/x&sa=U">skip</a>
	<a href="https://example.org/b?ref=1">B</a>
	<a href="/url?q=https://example.com/a&sa=U">dup</a>`
	res := parseGoogleResults(body, 8)
	if len(res) != 2 {
		t.Fatalf("expected 2 results, got %d: %+v", len(res), res)
	}
	if res[0].URL != "https://example.com/a" || res[1].URL != "https://example.org/b?ref=1" {
		t.Errorf("unexpected urls: %+v", res)
	}
}

// TestParseDDGResults checks DuckDuckGo HTML parsing incl. uddg redirect decoding and
// snippet pairing.
func TestParseDDGResults(t *testing.T) {
	body := `
	<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=x">The <b>Title</b></a>
	<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">A short summary.</a>`
	res := parseDDGResults(body, 8)
	if len(res) != 1 {
		t.Fatalf("expected 1 result, got %d: %+v", len(res), res)
	}
	if res[0].URL != "https://example.com/page" {
		t.Errorf("uddg not decoded: %q", res[0].URL)
	}
	if res[0].Title != "The Title" {
		t.Errorf("title = %q", res[0].Title)
	}
	if res[0].Snippet != "A short summary." {
		t.Errorf("snippet = %q", res[0].Snippet)
	}
}
