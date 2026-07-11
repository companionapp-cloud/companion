//go:build js

package bridge

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"companion/core/calendar"
)

// fetchICS on web routes the feed through the server's blind proxy (POST /v1/calendar/proxy),
// because a browser can't fetch an arbitrary cross-origin ICS URL (CORS). The proxy streams the
// body back without storing or logging it, so the only exposure is the URL transiting server
// memory per request — nothing at rest (PLAN §E2EE). Native clients fetch directly instead.
func (c *Core) fetchICS(rawURL string) ([]byte, error) {
	if c.sync.baseURL == "" {
		return nil, errors.New("calendar URL feeds require sync to be configured (web fetches via the server proxy)")
	}
	reqBody, _ := json.Marshal(map[string]string{"url": rawURL})
	req, err := http.NewRequest(http.MethodPost, c.sync.baseURL+"/v1/calendar/proxy", bytes.NewReader(reqBody))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.sync.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.sync.token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("calendar proxy status %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, calendar.MaxICSBytes))
}
