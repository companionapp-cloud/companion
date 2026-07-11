//go:build !js

package bridge

import (
	"fmt"
	"io"
	"net/http"
	"time"

	"companion/core/calendar"
)

// icsClient fetches feeds with a bounded timeout so a slow host can't wedge a refresh.
var icsClient = &http.Client{Timeout: 30 * time.Second}

// fetchICS downloads a feed URL directly (desktop/mobile). Native clients fetch the source
// straight from the publisher — the server never sees the URL, which is the point of moving the
// fetch client-side (PLAN §E2EE). Web uses a different implementation (the server proxy) because
// browsers can't fetch arbitrary cross-origin ICS.
func (c *Core) fetchICS(rawURL string) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, calendar.NormalizeFeedURL(rawURL), nil)
	if err != nil {
		return nil, err
	}
	// Some ICS hosts (Google among them) reject the default Go user-agent or an absent Accept
	// header; present as a normal calendar client so subscriptions actually download.
	req.Header.Set("User-Agent", "Companion-Calendar/1.0")
	req.Header.Set("Accept", "text/calendar, text/plain;q=0.9, */*;q=0.5")
	resp, err := icsClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ics status %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, calendar.MaxICSBytes))
}
