package unfurl

import (
	"strings"
	"testing"
)

func TestParseOpenGraph(t *testing.T) {
	body := `<html><head>
	<title>Fallback &amp; ignored</title>
	<meta property="og:title" content="Hello   World" />
	<meta content='A &quot;fine&quot; page' property='og:description'>
	<meta property="og:image" content="/img/cover.png">
	<meta property="og:site_name" content="Example">
	<link rel="shortcut icon" href="/static/fav.ico">
	</head><body></body></html>`
	p := Parse("https://www.example.com/posts/1?x=1", []byte(body))
	if p.Title != "Hello World" {
		t.Errorf("title = %q", p.Title)
	}
	if p.Description != `A "fine" page` {
		t.Errorf("description = %q", p.Description)
	}
	if p.ImageURL != "https://www.example.com/img/cover.png" {
		t.Errorf("image = %q", p.ImageURL)
	}
	if p.SiteName != "Example" {
		t.Errorf("site = %q", p.SiteName)
	}
	if p.FaviconURL != "https://www.example.com/static/fav.ico" {
		t.Errorf("favicon = %q", p.FaviconURL)
	}
}

func TestParseFallbacks(t *testing.T) {
	body := `<html><head><title>
	  Plain   Title
	</title><meta name="description" content="Meta desc"><meta name="twitter:image" content="https://cdn.example.org/t.jpg"></head></html>`
	p := Parse("https://blog.example.org/a", []byte(body))
	if p.Title != "Plain Title" || p.Description != "Meta desc" {
		t.Errorf("fallbacks: %+v", p)
	}
	if p.ImageURL != "https://cdn.example.org/t.jpg" {
		t.Errorf("twitter image = %q", p.ImageURL)
	}
	if p.SiteName != "blog.example.org" {
		t.Errorf("site fallback = %q", p.SiteName)
	}
	if p.FaviconURL != "https://blog.example.org/favicon.ico" {
		t.Errorf("favicon fallback = %q", p.FaviconURL)
	}
}

func TestParseRejectsNonHTTPImages(t *testing.T) {
	body := `<meta property="og:image" content="data:image/png;base64,AAAA">`
	if p := Parse("https://x.example", []byte(body)); p.ImageURL != "" {
		t.Errorf("data: image should be dropped, got %q", p.ImageURL)
	}
}

func TestParseOversized(t *testing.T) {
	head := `<meta property="og:title" content="Big">`
	body := head + strings.Repeat("x", MaxBytes*2)
	if p := Parse("https://x.example", []byte(body)); p.Title != "Big" {
		t.Errorf("oversized body: %+v", p)
	}
	if p := Parse("https://x.example", []byte(`<meta property="og:title" content="`+strings.Repeat("t", 1000)+`">`)); len([]rune(p.Title)) != 301 {
		t.Errorf("title should be capped, got %d runes", len([]rune(p.Title)))
	}
}

func TestNormalize(t *testing.T) {
	cases := map[string]string{
		"example.com/a":        "https://example.com/a",
		" http://x.io ":        "http://x.io",
		"javascript:alert(1)":  "",
		"":                     "",
		"ftp://files.example":  "",
		"https://ok.example/p": "https://ok.example/p",
	}
	for in, want := range cases {
		if got := Normalize(in); got != want {
			t.Errorf("Normalize(%q) = %q, want %q", in, got, want)
		}
	}
}
