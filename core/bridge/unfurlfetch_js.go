//go:build js

package bridge

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"companion/core/unfurl"
)

// fetchPage on web routes the request through the server's blind fetch proxy
// (POST /v1/proxy/fetch), because a browser can't read an arbitrary cross-origin page
// (CORS). The proxy relays the body without storing or logging it (PLAN-canvases.md §4.3).
// The response carries the final URL after redirects in X-Final-URL.
func (c *Core) fetchPage(rawURL string) (string, []byte, error) {
	if c.sync.baseURL == "" {
		return "", nil, errors.New("link previews require sync to be configured (web fetches via the server proxy)")
	}
	reqBody, _ := json.Marshal(map[string]string{"url": rawURL})
	req, err := http.NewRequest(http.MethodPost, c.sync.baseURL+"/v1/proxy/fetch", bytes.NewReader(reqBody))
	if err != nil {
		return "", nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.sync.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.sync.token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnsupportedMediaType {
		return rawURL, nil, nil // not a page; preview falls back to the bare URL
	}
	if resp.StatusCode != http.StatusOK {
		return "", nil, fmt.Errorf("fetch proxy status %d", resp.StatusCode)
	}
	final := resp.Header.Get("X-Final-URL")
	if final == "" {
		final = rawURL
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, unfurl.MaxBytes))
	if err != nil {
		return "", nil, err
	}
	return final, body, nil
}
