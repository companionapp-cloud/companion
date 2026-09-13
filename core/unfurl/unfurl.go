// Package unfurl extracts a link preview (title, description, image, site name, favicon)
// from an HTML page — the Open Graph / Twitter card metadata a chat client shows under a
// pasted URL. It is pure parsing over bytes so every platform runs the same code; the
// fetch itself lives in the bridge (direct on native, through the server's blind proxy on
// web, see PLAN-canvases.md §4.3). Regex-based on purpose: the core has no HTML parser
// dependency, and meta/title/link tags are flat enough that a tokenizer isn't needed.
package unfurl

import (
	"html"
	"net/url"
	"regexp"
	"strings"
)

// MaxBytes caps how much of a page is read for metadata; everything useful sits in <head>.
const MaxBytes = 2 << 20 // 2 MiB

// Preview is the extracted metadata. Empty fields mean "not present".
type Preview struct {
	URL         string `json:"url"`
	Title       string `json:"title"`
	Description string `json:"description"`
	ImageURL    string `json:"imageUrl"`
	SiteName    string `json:"siteName"`
	FaviconURL  string `json:"faviconUrl"`
}

var (
	reMeta  = regexp.MustCompile(`(?is)<meta\b[^>]*>`)
	reLink  = regexp.MustCompile(`(?is)<link\b[^>]*>`)
	reTitle = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	reAttr  = regexp.MustCompile(`(?is)([a-z][a-z0-9:_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))`)
	reSpace = regexp.MustCompile(`\s+`)
)

// attrs parses the attributes of one tag into a lowercase-keyed map.
func attrs(tag string) map[string]string {
	out := map[string]string{}
	for _, m := range reAttr.FindAllStringSubmatch(tag, -1) {
		v := m[2]
		if v == "" {
			v = m[3]
		}
		if v == "" {
			v = m[4]
		}
		out[strings.ToLower(m[1])] = html.UnescapeString(v)
	}
	return out
}

// clean collapses whitespace and trims a text value.
func clean(s string) string {
	return strings.TrimSpace(reSpace.ReplaceAllString(html.UnescapeString(s), " "))
}

// Parse extracts a preview from page bytes. pageURL (the final URL after redirects)
// resolves relative image/icon links and fills the fallback site name.
func Parse(pageURL string, body []byte) Preview {
	if len(body) > MaxBytes {
		body = body[:MaxBytes]
	}
	src := string(body)
	p := Preview{URL: pageURL}
	base, _ := url.Parse(pageURL)

	og := map[string]string{}
	tw := map[string]string{}
	plain := map[string]string{}
	for _, tag := range reMeta.FindAllString(src, -1) {
		a := attrs(tag)
		content := clean(a["content"])
		if content == "" {
			continue
		}
		key := strings.ToLower(a["property"])
		if key == "" {
			key = strings.ToLower(a["name"])
		}
		switch {
		case strings.HasPrefix(key, "og:"):
			if _, dup := og[key]; !dup {
				og[key] = content
			}
		case strings.HasPrefix(key, "twitter:"):
			if _, dup := tw[key]; !dup {
				tw[key] = content
			}
		case key != "":
			if _, dup := plain[key]; !dup {
				plain[key] = content
			}
		}
	}

	pick := func(keys ...string) string {
		for _, k := range keys {
			if v := og[k]; v != "" {
				return v
			}
			if v := tw[k]; v != "" {
				return v
			}
			if v := plain[k]; v != "" {
				return v
			}
		}
		return ""
	}

	p.Title = pick("og:title", "twitter:title")
	if p.Title == "" {
		if m := reTitle.FindStringSubmatch(src); m != nil {
			p.Title = clean(m[1])
		}
	}
	p.Description = pick("og:description", "twitter:description", "description")
	p.SiteName = pick("og:site_name")
	if p.SiteName == "" && base != nil {
		p.SiteName = strings.TrimPrefix(base.Hostname(), "www.")
	}
	p.ImageURL = resolve(base, pick("og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"))

	// Favicon: the first <link rel="…icon…"> wins; fall back to /favicon.ico.
	for _, tag := range reLink.FindAllString(src, -1) {
		a := attrs(tag)
		rel := strings.ToLower(a["rel"])
		if a["href"] == "" || !strings.Contains(rel, "icon") || strings.Contains(rel, "mask-icon") {
			continue
		}
		p.FaviconURL = resolve(base, a["href"])
		if p.FaviconURL != "" {
			break
		}
	}
	if p.FaviconURL == "" && base != nil && base.Host != "" {
		p.FaviconURL = base.Scheme + "://" + base.Host + "/favicon.ico"
	}

	// Cap runaway fields so a preview never bloats a node's payload.
	p.Title = truncate(p.Title, 300)
	p.Description = truncate(p.Description, 600)
	p.SiteName = truncate(p.SiteName, 120)
	return p
}

// resolve makes a possibly-relative reference absolute against the page URL. Non-http
// results (data:, javascript:) are dropped.
func resolve(base *url.URL, ref string) string {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return ""
	}
	u, err := url.Parse(ref)
	if err != nil {
		return ""
	}
	if base != nil {
		u = base.ResolveReference(u)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return ""
	}
	return u.String()
}

func truncate(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}

// Normalize trims a pasted URL and defaults a missing scheme to https, returning "" for
// anything that still isn't an http(s) URL with a host.
func Normalize(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return ""
	}
	return u.String()
}
