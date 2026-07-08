//go:build !js

// The web-reading tools (read_from_internet, read_from_google) make outbound HTTP requests.
// In the web build the core runs in the browser, where those go through fetch() and are
// CORS-blocked for arbitrary origins — so they're excluded there (see tools_web_js.go) and
// simply not advertised to the model. Desktop and mobile (native HTTP) include them.
package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	neturl "net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Web-reading tool (PLAN §6.8). read_from_internet fetches a public page and hands the model
// its readable text (HTML markup stripped), so it can ground answers in a specific URL the
// user provides. It runs in the Go core: direct HTTP on desktop/mobile, and through the
// browser's fetch() on the web build — where cross-origin pages are subject to CORS and will
// often be blocked. That's a platform limitation of running in the browser, not this tool.

const (
	webFetchTimeout = 20 * time.Second
	webMaxBytes     = 3 << 20 // cap the download at 3 MB
	webMaxChars     = 12000   // cap the returned text (~a few thousand tokens)
	// A real desktop-browser User-Agent. Many sites — and, critically, DuckDuckGo's HTML
	// search endpoint — reject or serve an anti-bot challenge page to requests advertising a
	// bot UA, so we present as Chrome to get actual results back.
	webUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

var webClient = &http.Client{Timeout: webFetchTimeout}

var (
	reTitle       = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	reScriptStyle = regexp.MustCompile(`(?is)<(script|style|noscript|template)\b[^>]*>.*?</(script|style|noscript|template)>`)
	reComment     = regexp.MustCompile(`(?s)<!--.*?-->`)
	reBlockClose  = regexp.MustCompile(`(?i)</(p|div|li|ul|ol|h[1-6]|section|article|header|footer|tr|table|blockquote)>`)
	reBr          = regexp.MustCompile(`(?i)<br\s*/?>`)
	reTag         = regexp.MustCompile(`(?s)<[^>]+>`)
	reInlineWS    = regexp.MustCompile(`[ \t\f\v\x{00a0}]+`)
	reBlankLines  = regexp.MustCompile(`\n{3,}`)
)

// addWebTools registers the internet-reading and web-search tools on a registry.
func addWebTools(r *Registry) {
	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "read_from_internet",
			Description: "Fetch a public web page by its URL and return its readable text (HTML markup removed), so you can read and use the page's content. Call this when the user gives you a link or asks you to read/look something up on a specific page. Very long pages are truncated. Only works for http(s) pages; it can't log in, run JavaScript, or reach private/local addresses.",
			Schema:      json.RawMessage(`{"type":"object","additionalProperties":false,"properties":{"url":{"type":"string","description":"The full http(s) URL of the page to read."}},"required":["url"]}`),
		},
		Handler: readFromInternet,
	})

	r.Add(Tool{
		Spec: ToolSpec{
			Name:        "read_from_google",
			Description: "Search the web for a term and get back a ranked list of result links (title, url, snippet). Call this when the user asks you to look something up, research a topic online, or find pages, and you don't already have a URL. Then read the most relevant results with read_from_internet to get their full content and answer.",
			Schema:      json.RawMessage(`{"type":"object","additionalProperties":false,"properties":{"query":{"type":"string","description":"What to search for."},"limit":{"type":"integer","description":"Max results (default 8)."}},"required":["query"]}`),
		},
		Handler: readFromGoogle,
	})
}

// searchResult is one web-search hit the model can choose to open with read_from_internet.
type searchResult struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet,omitempty"`
}

var (
	reGoogleURLQ   = regexp.MustCompile(`href="/url\?q=(https?://[^&"]+)`)
	reGoogleDirect = regexp.MustCompile(`href="(https?://[^"]+)"`)
	reDDGResult    = regexp.MustCompile(`(?s)<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>`)
	reDDGSnippet   = regexp.MustCompile(`(?s)class="result__snippet"[^>]*>(.*?)</a>`)
	reUddg         = regexp.MustCompile(`[?&]uddg=([^&]+)`)
)

func readFromGoogle(ctx context.Context, args json.RawMessage) (string, error) {
	var a struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return "", err
	}
	query := strings.TrimSpace(a.Query)
	if query == "" {
		return "", fmt.Errorf("query is required")
	}
	limit := a.Limit
	if limit <= 0 || limit > 10 {
		limit = 8
	}

	// Try Google first; it frequently blocks non-browser requests, so fall back to
	// DuckDuckGo's HTML endpoint (reliably scrapeable, no API key) to still return results.
	source := "google"
	results, err := googleSearch(ctx, query, limit)
	if err != nil || len(results) == 0 {
		if ddg, derr := ddgSearch(ctx, query, limit); derr == nil && len(ddg) > 0 {
			results, source = ddg, "duckduckgo"
		} else if err != nil {
			return "", fmt.Errorf("web search failed: %w", err)
		}
	}
	if len(results) == 0 {
		return "", fmt.Errorf("no results for %q", query)
	}
	return jsonResult(map[string]any{"query": query, "source": source, "results": results})
}

func googleSearch(ctx context.Context, query string, limit int) ([]searchResult, error) {
	body, err := fetchSearchHTML(ctx, "https://www.google.com/search?hl=en&num="+strconv.Itoa(limit*2)+"&q="+neturl.QueryEscape(query))
	if err != nil {
		return nil, err
	}
	return parseGoogleResults(body, limit), nil
}

// parseGoogleResults extracts external result links from a Google results page, preferring
// the /url?q= redirect form and falling back to direct links, skipping Google's own hosts.
func parseGoogleResults(body string, limit int) []searchResult {
	seen := map[string]bool{}
	var out []searchResult
	add := func(raw string) {
		dec, e := neturl.QueryUnescape(raw)
		if e != nil || dec == "" {
			dec = raw
		}
		u, e := neturl.Parse(dec)
		if e != nil || (u.Scheme != "http" && u.Scheme != "https") || isSearchEngineHost(u.Host) {
			return
		}
		key := u.Scheme + "://" + u.Host + u.Path
		if seen[key] {
			return
		}
		seen[key] = true
		out = append(out, searchResult{Title: u.Host, URL: dec})
	}
	for _, m := range reGoogleURLQ.FindAllStringSubmatch(body, -1) {
		if len(out) >= limit {
			return out
		}
		add(m[1])
	}
	for _, m := range reGoogleDirect.FindAllStringSubmatch(body, -1) {
		if len(out) >= limit {
			break
		}
		add(m[1])
	}
	return out
}

func ddgSearch(ctx context.Context, query string, limit int) ([]searchResult, error) {
	// DuckDuckGo's HTML endpoint only returns results for a POST with the form-encoded query
	// and a browser UA; a GET (or a bot UA) is answered with a challenge/"anomaly" page that
	// carries no results. POSTing the form is what keeps web search working.
	body, err := postSearchHTML(ctx, "https://html.duckduckgo.com/html/", neturl.Values{"q": {query}})
	if err != nil {
		return nil, err
	}
	return parseDDGResults(body, limit), nil
}

// parseDDGResults extracts titled results (with snippets) from DuckDuckGo's HTML endpoint,
// decoding its uddg redirect links back to the real target URLs.
func parseDDGResults(body string, limit int) []searchResult {
	snippets := reDDGSnippet.FindAllStringSubmatch(body, -1)
	var out []searchResult
	for i, m := range reDDGResult.FindAllStringSubmatch(body, -1) {
		href := m[1]
		if uddg := reUddg.FindStringSubmatch(href); len(uddg) == 2 {
			if dec, e := neturl.QueryUnescape(uddg[1]); e == nil {
				href = dec
			}
		}
		if strings.HasPrefix(href, "//") {
			href = "https:" + href
		}
		u, e := neturl.Parse(href)
		if e != nil || (u.Scheme != "http" && u.Scheme != "https") {
			continue
		}
		// Skip DuckDuckGo's own hosts: sponsored "y.js" ad links (and any undecoded
		// redirect) point back at duckduckgo.com, not a real result.
		if strings.Contains(strings.ToLower(u.Host), "duckduckgo.com") {
			continue
		}
		snippet := ""
		if i < len(snippets) {
			snippet = stripInline(snippets[i][1])
		}
		out = append(out, searchResult{Title: stripInline(m[2]), URL: href, Snippet: snippet})
		if len(out) >= limit {
			break
		}
	}
	return out
}

// fetchSearchHTML GETs a search results page with a browser-like UA and returns the HTML.
func fetchSearchHTML(ctx context.Context, url string) (string, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	return doSearchRequest(ctx, req)
}

// postSearchHTML POSTs a form-encoded search query (some engines, e.g. DuckDuckGo's HTML
// endpoint, only serve results to POST) with a browser-like UA and returns the HTML.
func postSearchHTML(ctx context.Context, endpoint string, form neturl.Values) (string, error) {
	req, err := http.NewRequest(http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return doSearchRequest(ctx, req)
}

// doSearchRequest sets the shared browser-like headers, applies the fetch timeout, executes
// the request, and returns the (size-capped) response body.
func doSearchRequest(ctx context.Context, req *http.Request) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, webFetchTimeout)
	defer cancel()
	req = req.WithContext(ctx)
	req.Header.Set("User-Agent", webUserAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	resp, err := webClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("search returned HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, webMaxBytes))
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// isSearchEngineHost reports whether a host is a search engine's own (not a real result).
func isSearchEngineHost(host string) bool {
	host = strings.ToLower(host)
	return strings.Contains(host, "google") || strings.Contains(host, "gstatic") || strings.Contains(host, "googleusercontent")
}

// stripInline reduces an inline HTML fragment to plain text.
func stripInline(s string) string {
	s = reTag.ReplaceAllString(s, "")
	s = html.UnescapeString(s)
	s = reInlineWS.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

func readFromInternet(ctx context.Context, args json.RawMessage) (string, error) {
	var a struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return "", err
	}
	u, err := neturl.Parse(strings.TrimSpace(a.URL))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("invalid url %q — must be a full http(s) URL", a.URL)
	}

	ctx, cancel := context.WithTimeout(ctx, webFetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", webUserAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8")

	resp, err := webClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("could not fetch %s: %w", u.Host, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("fetching %s returned HTTP %d", u.Host, resp.StatusCode)
	}

	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	isHTML := strings.Contains(ct, "html")
	if !isHTML && !strings.HasPrefix(ct, "text/") && !strings.Contains(ct, "json") && !strings.Contains(ct, "xml") {
		return "", fmt.Errorf("cannot read %s: it is %q, not a web page or text", u.Host, ct)
	}

	raw, err := io.ReadAll(io.LimitReader(resp.Body, webMaxBytes))
	if err != nil {
		return "", fmt.Errorf("reading %s: %w", u.Host, err)
	}

	title, text := "", strings.TrimSpace(string(raw))
	if isHTML {
		title, text = htmlToText(string(raw))
	}
	truncated := false
	if runes := []rune(text); len(runes) > webMaxChars {
		text = string(runes[:webMaxChars])
		truncated = true
	}
	return jsonResult(map[string]any{"url": u.String(), "title": title, "text": text, "truncated": truncated})
}

// htmlToText strips a page down to readable text: it lifts the <title>, drops script/style/
// comment blocks, turns block-level tags into line breaks, removes the remaining tags,
// decodes entities, and collapses runs of whitespace.
func htmlToText(body string) (title, text string) {
	if m := reTitle.FindStringSubmatch(body); len(m) == 2 {
		title = strings.TrimSpace(html.UnescapeString(reTag.ReplaceAllString(m[1], "")))
	}
	s := reComment.ReplaceAllString(body, " ")
	s = reScriptStyle.ReplaceAllString(s, " ")
	s = reBlockClose.ReplaceAllString(s, "\n")
	s = reBr.ReplaceAllString(s, "\n")
	s = reTag.ReplaceAllString(s, "")
	s = html.UnescapeString(s)
	s = reInlineWS.ReplaceAllString(s, " ")
	lines := strings.Split(s, "\n")
	for i := range lines {
		lines[i] = strings.TrimSpace(lines[i])
	}
	s = reBlankLines.ReplaceAllString(strings.Join(lines, "\n"), "\n\n")
	return title, strings.TrimSpace(s)
}
