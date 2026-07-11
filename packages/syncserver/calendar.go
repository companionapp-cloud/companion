package syncserver

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"companion/core/calendar"
)

// Calendar under end-to-end encryption (PLAN §E2EE): the server no longer fetches, parses, or
// stores ICS feeds. Clients fetch their own feeds, expand them on-device, and push the resulting
// events as ordinary (encrypted) rows — so the server sees neither the feed URL (a bearer secret)
// nor the event content. The only server involvement left is a blind proxy for web clients, which
// cannot fetch arbitrary cross-origin ICS from the browser (CORS). The proxy streams a URL's body
// back and stores/logs nothing.

// maxICSBytes caps a proxied ICS body to guard against a hostile or runaway feed.
const maxICSBytes = 10 << 20 // 10 MiB

// icsClient fetches proxied feeds with a bounded timeout so a slow host can't tie up a request.
var icsClient = &http.Client{
	Timeout: 30 * time.Second,
	// Re-validate every hop of a redirect chain against the SSRF guard, so a public URL can't
	// 302 the proxy into the internal network.
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return fmt.Errorf("too many redirects")
		}
		return guardProxyURL(req.URL.String())
	},
}

type proxyRequest struct {
	URL string `json:"url"`
}

// handleCalendarProxy fetches an ICS URL on behalf of a web client and returns the raw body
// verbatim, storing and logging nothing. It exists only because browsers can't fetch arbitrary
// cross-origin ICS; native clients fetch directly and never hit this. The SSRF guard blocks
// non-HTTP schemes and private/loopback/link-local hosts so the proxy can't be turned into a
// window onto the server's internal network.
func (s *Server) handleCalendarProxy(w http.ResponseWriter, r *http.Request) {
	var req proxyRequest
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	target := calendar.NormalizeFeedURL(req.URL)
	if err := guardProxyURL(target); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	preq, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target, nil)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid url")
		return
	}
	preq.Header.Set("User-Agent", "Companion-Calendar/1.0")
	preq.Header.Set("Accept", "text/calendar, text/plain;q=0.9, */*;q=0.5")
	resp, err := icsClient.Do(preq)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "fetch failed")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		writeErr(w, http.StatusBadGateway, fmt.Sprintf("ics status %d", resp.StatusCode))
		return
	}
	w.Header().Set("Content-Type", "text/calendar")
	io.Copy(w, io.LimitReader(resp.Body, maxICSBytes))
}

// guardProxyURL rejects anything but an http(s) URL to a public host, blocking the SSRF vectors a
// blind fetch proxy would otherwise expose (loopback, private ranges, link-local, unspecified).
func guardProxyURL(raw string) error {
	u, err := parseHTTPURL(raw)
	if err != nil {
		return err
	}
	host := u
	if h, _, err := net.SplitHostPort(u); err == nil {
		host = h
	}
	// A literal IP is checked directly; a hostname is checked against every address it resolves to.
	var ips []net.IP
	if ip := net.ParseIP(host); ip != nil {
		ips = []net.IP{ip}
	} else {
		resolved, err := net.LookupIP(host)
		if err != nil {
			return fmt.Errorf("cannot resolve host")
		}
		ips = resolved
	}
	for _, ip := range ips {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
			return fmt.Errorf("url host is not allowed")
		}
	}
	return nil
}

// parseHTTPURL extracts the host from an http(s) URL, rejecting any other scheme.
func parseHTTPURL(raw string) (string, error) {
	lower := strings.ToLower(strings.TrimSpace(raw))
	switch {
	case strings.HasPrefix(lower, "https://"):
		return hostOf(raw[len("https://"):]), nil
	case strings.HasPrefix(lower, "http://"):
		return hostOf(raw[len("http://"):]), nil
	}
	return "", fmt.Errorf("only http(s) urls are allowed")
}

// hostOf returns the authority (host[:port]) portion of a URL remainder after the scheme.
func hostOf(rest string) string {
	if i := strings.IndexAny(rest, "/?#"); i >= 0 {
		rest = rest[:i]
	}
	if at := strings.LastIndex(rest, "@"); at >= 0 { // strip userinfo
		rest = rest[at+1:]
	}
	return rest
}
