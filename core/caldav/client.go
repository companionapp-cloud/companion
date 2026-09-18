// Package caldav is a small CalDAV (RFC 4791) client: discovery, listing a calendar's objects,
// and conditional writes. It exists because write-back is only safe with If-Match / If-None-Match
// on every mutation, which the general-purpose WebDAV libraries do not expose (PLAN-caldav.md §0).
//
// The client is only ever built on native shells. It talks straight to the provider over TLS, so
// the sync server never sees a credential, a calendar URL or an event (PLAN §E2EE).
package caldav

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var (
	// ErrPreconditionFailed is a 412: the resource changed since the etag we hold (update/delete),
	// or already exists (create).
	ErrPreconditionFailed = errors.New("caldav: precondition failed")
	// ErrNotFound is a 404/410 on a resource.
	ErrNotFound = errors.New("caldav: not found")
	// ErrUnauthorized is a 401: wrong credential, or an account that needs an app password.
	ErrUnauthorized = errors.New("caldav: not authorized")
	// ErrForbidden is a 403: the login is fine but may not do this (a read-only calendar).
	ErrForbidden = errors.New("caldav: forbidden")
	// ErrNoCalendars means discovery could not find a calendar home at the given URL.
	ErrNoCalendars = errors.New("caldav: no calendars found at this address")
)

// StatusError is any other non-success HTTP status.
type StatusError struct {
	Method string
	Status int
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("caldav: %s returned %d", e.Method, e.Status)
}

const (
	userAgent       = "Companion-Calendar/1.0"
	maxResponseSize = 32 << 20
	maxRedirects    = 5
	multiGetBatch   = 50
)

// Calendar is one collection of a calendar home.
type Calendar struct {
	URL   string
	Name  string
	Color string // "#RRGGBB", or "" when the server does not publish one
	CTag  string
	// ReadOnly is true when the server reports privileges and none of them allow writing.
	ReadOnly bool
}

// Entry is one resource of a calendar, by URL and version.
type Entry struct {
	Href string
	ETag string
}

// Object is one calendar object resource with its body.
type Object struct {
	Href string
	ETag string
	ICS  string
}

// Auth puts a login on a request. Basic is a username and (app) password; Bearer is an OAuth
// access token, which is how Google's CalDAV endpoint authenticates (PLAN-caldav.md §9).
type Auth interface {
	Apply(ctx context.Context, req *http.Request) error
	// Invalidate is called on a 401. It reports whether a retry could go differently — true for
	// a bearer token that can be refreshed, false for a password that is simply wrong.
	Invalidate() bool
}

// Basic is HTTP basic auth.
type Basic struct{ Username, Password string }

func (b Basic) Apply(_ context.Context, req *http.Request) error {
	if b.Username != "" || b.Password != "" {
		req.SetBasicAuth(b.Username, b.Password)
	}
	return nil
}
func (Basic) Invalidate() bool { return false }

// TokenSource supplies OAuth access tokens. oauth.TokenSource satisfies it; this package stays
// ignorant of OAuth itself.
type TokenSource interface {
	Token(ctx context.Context) (string, error)
	Invalidate() bool
}

// Bearer authenticates with an OAuth access token.
type Bearer struct{ Source TokenSource }

func (b Bearer) Apply(ctx context.Context, req *http.Request) error {
	tok, err := b.Source.Token(ctx)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	return nil
}
func (b Bearer) Invalidate() bool { return b.Source.Invalidate() }

// Client is a CalDAV session for one login.
type Client struct {
	http *http.Client
	base *url.URL
	auth Auth
}

// New builds a client for a server URL and a basic-auth login. httpClient may be nil.
func New(serverURL, username, password string, httpClient *http.Client) (*Client, error) {
	return NewWithAuth(serverURL, Basic{Username: username, Password: password}, httpClient)
}

// NewWithAuth builds a client with any Auth.
func NewWithAuth(serverURL string, auth Auth, httpClient *http.Client) (*Client, error) {
	base, err := ParseServerURL(serverURL)
	if err != nil {
		return nil, err
	}
	hc := &http.Client{Timeout: 30 * time.Second}
	if httpClient != nil {
		cp := *httpClient
		hc = &cp
	}
	// Redirects are followed by hand (see do): net/http turns a redirected PROPFIND into a GET,
	// and would forward the Authorization header wherever the server points.
	hc.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Client{http: hc, base: base, auth: auth}, nil
}

// ParseServerURL normalises what a user typed ("caldav.icloud.com") and enforces the transport
// rule: https everywhere, plain http only for a server on this machine or this network, where
// there is no certificate to be had and the password does not cross the internet.
func ParseServerURL(raw string) (*url.URL, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil, errors.New("a server address is required")
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" {
		return nil, errors.New("that doesn't look like a server address")
	}
	switch u.Scheme {
	case "https":
	case "http":
		if !isLocalHost(u.Hostname()) {
			return nil, errors.New("this server must be reached over https")
		}
	default:
		return nil, errors.New("the server address must start with https://")
	}
	if u.Path == "" {
		u.Path = "/"
	}
	u.Fragment = ""
	return u, nil
}

// Discover finds the calendar home set: current-user-principal, then calendar-home-set, trying
// /.well-known/caldav when the given URL is not itself a DAV resource (RFC 6764). A URL that
// already is a calendar home is accepted as-is.
func (c *Client) Discover(ctx context.Context) (string, error) {
	candidates := []string{c.base.String()}
	wellKnown := *c.base
	wellKnown.Path, wellKnown.RawQuery = "/.well-known/caldav", ""
	if wellKnown.String() != c.base.String() {
		candidates = append(candidates, wellKnown.String())
	}
	var firstErr error
	for _, start := range candidates {
		home, err := c.discoverFrom(ctx, start)
		if err == nil {
			return home, nil
		}
		if errors.Is(err, ErrUnauthorized) {
			return "", err
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	// Last resort: the address may already be a calendar home.
	if cals, err := c.Calendars(ctx, c.base.String()); err == nil && len(cals) > 0 {
		return c.base.String(), nil
	}
	if firstErr == nil || errors.Is(firstErr, ErrNotFound) {
		firstErr = ErrNoCalendars
	}
	return "", firstErr
}

func (c *Client) discoverFrom(ctx context.Context, start string) (string, error) {
	ms, at, err := c.propfind(ctx, start, "0", `<d:current-user-principal/>`)
	if err != nil {
		return "", err
	}
	principal := ""
	for _, r := range ms.Responses {
		if p := r.ok(); p != nil && p.Principal.Href != "" {
			principal = resolve(at, p.Principal.Href)
			break
		}
	}
	if principal == "" {
		// Some servers, handed the principal URL itself, don't echo current-user-principal back.
		// Ask it for the home set directly before giving up on this starting point.
		principal = start
	}
	ms, at, err = c.propfind(ctx, principal, "0", `<c:calendar-home-set/>`)
	if err != nil {
		return "", err
	}
	for _, r := range ms.Responses {
		if p := r.ok(); p != nil && p.HomeSet.Href != "" {
			return resolve(at, p.HomeSet.Href), nil
		}
	}
	return "", ErrNoCalendars
}

// Calendars lists the event calendars under a home set. Collections that cannot hold VEVENTs
// (reminder lists, inboxes) are skipped.
func (c *Client) Calendars(ctx context.Context, homeSetURL string) ([]Calendar, error) {
	ms, at, err := c.propfind(ctx, homeSetURL, "1",
		`<d:resourcetype/><d:displayname/><cs:getctag/><ic:calendar-color/>`+
			`<c:supported-calendar-component-set/><d:current-user-privilege-set/>`)
	if err != nil {
		return nil, err
	}
	var out []Calendar
	for _, r := range ms.Responses {
		p := r.ok()
		if p == nil || p.ResourceType.Calendar == nil || !p.supportsEvents() {
			continue
		}
		u := resolve(at, r.Href)
		name := strings.TrimSpace(p.DisplayName)
		if name == "" {
			name = lastSegment(u)
		}
		out = append(out, Calendar{URL: u, Name: name, Color: normalizeColor(p.Color), CTag: p.CTag, ReadOnly: p.readOnly()})
	}
	return out, nil
}

// CTag returns a calendar's collection tag: it changes whenever anything inside does, so an
// unchanged ctag means the pull can be skipped. "" when the server has no ctag.
func (c *Client) CTag(ctx context.Context, calendarURL string) (string, error) {
	ms, _, err := c.propfind(ctx, calendarURL, "0", `<cs:getctag/>`)
	if err != nil {
		return "", err
	}
	for _, r := range ms.Responses {
		if p := r.ok(); p != nil {
			return p.CTag, nil
		}
	}
	return "", nil
}

// ListETags returns the URL and etag of every event object overlapping [from, to], without bodies.
func (c *Client) ListETags(ctx context.Context, calendarURL string, from, to time.Time) ([]Entry, error) {
	const stamp = "20060102T150405Z"
	body := xmlHeader + `<c:calendar-query ` + xmlNS + `><d:prop><d:getetag/></d:prop>` +
		`<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">` +
		`<c:time-range start="` + from.UTC().Format(stamp) + `" end="` + to.UTC().Format(stamp) + `"/>` +
		`</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`
	ms, at, err := c.multistatus(ctx, "REPORT", calendarURL, "1", body)
	if err != nil {
		return nil, err
	}
	var out []Entry
	for _, r := range ms.Responses {
		if p := r.ok(); p != nil {
			out = append(out, Entry{Href: resolve(at, r.Href), ETag: p.ETag})
		}
	}
	return out, nil
}

// MultiGet fetches the bodies of the given object URLs, in batches.
func (c *Client) MultiGet(ctx context.Context, calendarURL string, hrefs []string) ([]Object, error) {
	var out []Object
	for len(hrefs) > 0 {
		n := min(len(hrefs), multiGetBatch)
		var b strings.Builder
		b.WriteString(xmlHeader + `<c:calendar-multiget ` + xmlNS + `><d:prop><d:getetag/><c:calendar-data/></d:prop>`)
		for _, h := range hrefs[:n] {
			b.WriteString(`<d:href>`)
			xml.EscapeText(&b, []byte(hrefPath(h)))
			b.WriteString(`</d:href>`)
		}
		b.WriteString(`</c:calendar-multiget>`)
		hrefs = hrefs[n:]

		ms, at, err := c.multistatus(ctx, "REPORT", calendarURL, "1", b.String())
		if err != nil {
			return nil, err
		}
		for _, r := range ms.Responses {
			if p := r.ok(); p != nil && strings.TrimSpace(p.CalendarData) != "" {
				out = append(out, Object{Href: resolve(at, r.Href), ETag: p.ETag, ICS: p.CalendarData})
			}
		}
	}
	return out, nil
}

// Get fetches one object.
func (c *Client) Get(ctx context.Context, href string) (*Object, error) {
	resp, err := c.do(ctx, http.MethodGet, href, "", map[string]string{"Accept": "text/calendar"})
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if err := statusErr(http.MethodGet, resp.StatusCode); err != nil {
		return nil, err
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseSize))
	if err != nil {
		return nil, err
	}
	return &Object{Href: resp.Request.URL.String(), ETag: resp.Header.Get("ETag"), ICS: string(body)}, nil
}

// Create PUTs a new object with If-None-Match: *, so it can never overwrite one that exists.
// The returned etag may be "" — some servers only reveal it on the next listing.
func (c *Client) Create(ctx context.Context, href, ics string) (string, error) {
	return c.put(ctx, href, ics, map[string]string{"If-None-Match": "*"})
}

// Update PUTs an object with If-Match, so it only lands on the version we last saw. An empty etag
// (a server that never told us one) degrades to an unconditional write.
func (c *Client) Update(ctx context.Context, href, ics, etag string) (string, error) {
	h := map[string]string{}
	if etag != "" {
		h["If-Match"] = etag
	}
	return c.put(ctx, href, ics, h)
}

func (c *Client) put(ctx context.Context, href, ics string, headers map[string]string) (string, error) {
	headers["Content-Type"] = "text/calendar; charset=utf-8"
	resp, err := c.do(ctx, http.MethodPut, href, ics, headers)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if err := statusErr(http.MethodPut, resp.StatusCode); err != nil {
		return "", err
	}
	return resp.Header.Get("ETag"), nil
}

// Delete removes an object, conditionally on its etag when we have one.
func (c *Client) Delete(ctx context.Context, href, etag string) error {
	h := map[string]string{}
	if etag != "" {
		h["If-Match"] = etag
	}
	resp, err := c.do(ctx, http.MethodDelete, href, "", h)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return statusErr(http.MethodDelete, resp.StatusCode)
}

// ObjectURL is where a new object with this UID is created inside a calendar.
func ObjectURL(calendarURL, uid string) string {
	base := calendarURL
	if !strings.HasSuffix(base, "/") {
		base += "/"
	}
	return base + url.PathEscape(uid) + ".ics"
}

// ---- transport -----------------------------------------------------------

func (c *Client) propfind(ctx context.Context, target, depth, props string) (*multistatus, *url.URL, error) {
	body := xmlHeader + `<d:propfind ` + xmlNS + `><d:prop>` + props + `</d:prop></d:propfind>`
	return c.multistatus(ctx, "PROPFIND", target, depth, body)
}

// multistatus sends an XML request and decodes the 207. It also returns the URL that finally
// answered, which relative hrefs in the response resolve against.
func (c *Client) multistatus(ctx context.Context, method, target, depth, body string) (*multistatus, *url.URL, error) {
	resp, err := c.do(ctx, method, target, body, map[string]string{
		"Content-Type": "application/xml; charset=utf-8",
		"Depth":        depth,
	})
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	if err := statusErr(method, resp.StatusCode); err != nil {
		return nil, nil, err
	}
	var ms multistatus
	if err := xml.NewDecoder(io.LimitReader(resp.Body, maxResponseSize)).Decode(&ms); err != nil {
		return nil, nil, fmt.Errorf("caldav: decode %s response: %w", method, err)
	}
	return &ms, resp.Request.URL, nil
}

// do sends one request, following redirects itself so the method and body survive them and the
// credential is never sent somewhere the user did not point us at.
func (c *Client) do(ctx context.Context, method, target, body string, headers map[string]string) (*http.Response, error) {
	reauthed := false
	for hop := 0; ; hop++ {
		u, err := url.Parse(target)
		if err != nil {
			return nil, err
		}
		if err := c.trusted(u); err != nil {
			return nil, err
		}
		req, err := http.NewRequestWithContext(ctx, method, u.String(), strings.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", userAgent)
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		// Applied only after trusted() above: the credential — password or token alike — is
		// never attached to a request bound for a host the user did not point us at.
		if err := c.auth.Apply(ctx, req); err != nil {
			return nil, err
		}
		resp, err := c.http.Do(req)
		if err != nil {
			return nil, err
		}
		// An access token can expire (or be revoked) mid-session. Drop it and try once more with
		// a fresh one; a second 401 is a real answer.
		if resp.StatusCode == http.StatusUnauthorized && !reauthed && c.auth.Invalidate() {
			resp.Body.Close()
			reauthed = true
			hop--
			continue
		}
		switch resp.StatusCode {
		case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther,
			http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
			loc := resp.Header.Get("Location")
			resp.Body.Close()
			if loc == "" || hop >= maxRedirects {
				return nil, errors.New("caldav: too many redirects")
			}
			target = resolve(u, loc)
			continue
		}
		return resp, nil
	}
}

// trusted decides whether a URL may receive the credential: same transport rule as the server
// URL, and the same site the user gave us. Providers legitimately hop hosts within their own
// domain (caldav.icloud.com hands out p42-caldav.icloud.com), so "same site" is the registrable
// domain, approximated as the last two labels.
func (c *Client) trusted(u *url.URL) error {
	if u.Scheme != "https" && !(u.Scheme == "http" && isLocalHost(u.Hostname())) {
		return fmt.Errorf("caldav: refusing to send credentials over %s to %s", u.Scheme, u.Host)
	}
	if !sameSite(c.base.Hostname(), u.Hostname()) {
		return fmt.Errorf("caldav: refusing to send credentials to %s", u.Host)
	}
	return nil
}

func sameSite(a, b string) bool {
	a, b = strings.ToLower(a), strings.ToLower(b)
	if a == b {
		return true
	}
	if net.ParseIP(a) != nil || net.ParseIP(b) != nil {
		return false
	}
	return site(a) != "" && site(a) == site(b)
}

func site(host string) string {
	labels := strings.Split(host, ".")
	if len(labels) < 2 {
		return ""
	}
	return strings.Join(labels[len(labels)-2:], ".")
}

func isLocalHost(host string) bool {
	h := strings.ToLower(host)
	if h == "localhost" || strings.HasSuffix(h, ".local") || strings.HasSuffix(h, ".localhost") {
		return true
	}
	if ip := net.ParseIP(h); ip != nil {
		return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()
	}
	return false
}

func statusErr(method string, status int) error {
	switch {
	case status >= 200 && status < 300:
		return nil
	case status == http.StatusPreconditionFailed:
		return ErrPreconditionFailed
	case status == http.StatusNotFound || status == http.StatusGone:
		return ErrNotFound
	case status == http.StatusUnauthorized:
		return ErrUnauthorized
	case status == http.StatusForbidden:
		return ErrForbidden
	}
	return &StatusError{Method: method, Status: status}
}

// resolve makes an href from a response absolute against the URL that served it.
func resolve(at *url.URL, href string) string {
	ref, err := url.Parse(strings.TrimSpace(href))
	if err != nil {
		return href
	}
	return at.ResolveReference(ref).String()
}

// hrefPath is the server-relative form of an object URL, which is what multiget hrefs must be.
func hrefPath(href string) string {
	u, err := url.Parse(href)
	if err != nil {
		return href
	}
	return u.EscapedPath()
}

func lastSegment(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	return parts[len(parts)-1]
}

// normalizeColor trims Apple's "#RRGGBBAA" down to "#RRGGBB"; anything unrecognised is dropped.
func normalizeColor(raw string) string {
	s := strings.TrimSpace(raw)
	if len(s) == 9 && s[0] == '#' {
		s = s[:7]
	}
	if len(s) != 7 || s[0] != '#' {
		return ""
	}
	for _, r := range s[1:] {
		if !strings.ContainsRune("0123456789abcdefABCDEF", r) {
			return ""
		}
	}
	return s
}

// ---- wire format ---------------------------------------------------------

const (
	xmlHeader = `<?xml version="1.0" encoding="utf-8"?>`
	xmlNS     = `xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/"`
)

type multistatus struct {
	Responses []response `xml:"DAV: response"`
}

type response struct {
	Href      string     `xml:"DAV: href"`
	Propstats []propstat `xml:"DAV: propstat"`
}

type propstat struct {
	Status string `xml:"DAV: status"`
	Prop   prop   `xml:"DAV: prop"`
}

type hrefProp struct {
	Href string `xml:"DAV: href"`
}

type prop struct {
	DisplayName  string `xml:"DAV: displayname"`
	ETag         string `xml:"DAV: getetag"`
	CTag         string `xml:"http://calendarserver.org/ns/ getctag"`
	Color        string `xml:"http://apple.com/ns/ical/ calendar-color"`
	CalendarData string `xml:"urn:ietf:params:xml:ns:caldav calendar-data"`
	ResourceType struct {
		Calendar *struct{} `xml:"urn:ietf:params:xml:ns:caldav calendar"`
	} `xml:"DAV: resourcetype"`
	Principal  hrefProp `xml:"DAV: current-user-principal"`
	HomeSet    hrefProp `xml:"urn:ietf:params:xml:ns:caldav calendar-home-set"`
	Components *struct {
		Comp []struct {
			Name string `xml:"name,attr"`
		} `xml:"urn:ietf:params:xml:ns:caldav comp"`
	} `xml:"urn:ietf:params:xml:ns:caldav supported-calendar-component-set"`
	Privileges *struct {
		Privilege []struct {
			All          *struct{} `xml:"DAV: all"`
			Write        *struct{} `xml:"DAV: write"`
			WriteContent *struct{} `xml:"DAV: write-content"`
			Bind         *struct{} `xml:"DAV: bind"`
		} `xml:"DAV: privilege"`
	} `xml:"DAV: current-user-privilege-set"`
}

// ok returns the properties the server answered with 200, or nil. A response carries one
// propstat per status, so the found properties and the 404 ones arrive separately.
func (r *response) ok() *prop {
	for i := range r.Propstats {
		if strings.Contains(r.Propstats[i].Status, " 200") {
			return &r.Propstats[i].Prop
		}
	}
	return nil
}

// supportsEvents is true unless the server says the collection holds only other components.
func (p *prop) supportsEvents() bool {
	if p.Components == nil || len(p.Components.Comp) == 0 {
		return true
	}
	for _, comp := range p.Components.Comp {
		if strings.EqualFold(comp.Name, "VEVENT") {
			return true
		}
	}
	return false
}

// readOnly is true only when privileges were reported and none of them allow writing.
func (p *prop) readOnly() bool {
	if p.Privileges == nil || len(p.Privileges.Privilege) == 0 {
		return false
	}
	for _, pr := range p.Privileges.Privilege {
		if pr.All != nil || pr.Write != nil || pr.WriteContent != nil || pr.Bind != nil {
			return false
		}
	}
	return true
}
