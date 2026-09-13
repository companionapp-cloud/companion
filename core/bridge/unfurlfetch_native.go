//go:build !js

package bridge

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"companion/core/unfurl"
)

// unfurlClient fetches pages for link previews with a bounded timeout.
var unfurlClient = &http.Client{Timeout: 15 * time.Second}

// fetchPage downloads a page directly (desktop/mobile) for link-preview extraction. Native
// clients fetch straight from the publisher — the server never sees the URL (PLAN §E2EE).
// Web uses the server's blind proxy instead (unfurlfetch_js.go). Returns the final URL
// after redirects alongside the (capped) body.
func (c *Core) fetchPage(rawURL string) (string, []byte, error) {
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return "", nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; Companion/1.0; +https://companion.app)")
	req.Header.Set("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5")
	resp, err := unfurlClient.Do(req)
	if err != nil {
		return "", nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", nil, fmt.Errorf("page status %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "" && !strings.Contains(ct, "html") {
		// Not a page (a PDF, an image, …): there's no metadata to read. The preview falls
		// back to the URL itself.
		return resp.Request.URL.String(), nil, nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, unfurl.MaxBytes))
	if err != nil {
		return "", nil, err
	}
	return resp.Request.URL.String(), body, nil
}
