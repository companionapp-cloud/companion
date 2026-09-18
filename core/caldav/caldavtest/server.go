// Package caldavtest is an in-memory CalDAV server for tests: enough of RFC 4791 to exercise
// discovery, listing, multiget and conditional writes, with knobs to simulate another client
// changing the calendar behind our back.
package caldavtest

import (
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"sync"
)

// Server is a fake provider with one principal and any number of calendars.
type Server struct {
	*httptest.Server
	Username, Password string
	// Bearer, when set, switches the server from basic auth to OAuth bearer tokens (as Google's
	// CalDAV endpoint does): it is asked whether an access token is currently valid.
	Bearer func(token string) bool

	mu        sync.Mutex
	calendars map[string]*calendar // by path, e.g. /cal/user/work/
	rev       int
	// Requests counts requests by method, so tests can assert a quiet calendar is not re-fetched.
	Requests map[string]int
}

type calendar struct {
	name, color string
	readOnly    bool
	tasksOnly   bool
	objects     map[string]*object // by path
}

type object struct {
	ics  string
	etag string
}

const (
	principalPath = "/principals/user/"
	homePath      = "/cal/user/"
)

// New starts a server with the given login.
func New(username, password string) *Server {
	s := &Server{Username: username, Password: password, calendars: map[string]*calendar{}, Requests: map[string]int{}}
	s.Server = httptest.NewServer(http.HandlerFunc(s.serve))
	return s
}

// AddCalendar creates a calendar and returns its absolute URL.
func (s *Server) AddCalendar(slug, name, color string, readOnly bool) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	path := homePath + slug + "/"
	s.calendars[path] = &calendar{name: name, color: color, readOnly: readOnly, objects: map[string]*object{}}
	return s.URL + path
}

// AddTaskList creates a VTODO-only collection, which clients must ignore.
func (s *Server) AddTaskList(slug, name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calendars[homePath+slug+"/"] = &calendar{name: name, tasksOnly: true, objects: map[string]*object{}}
}

// PutObject writes an object as if another client had (bumping its etag and the ctag), and
// returns its absolute URL.
func (s *Server) PutObject(calendarURL, name, ics string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	cal := s.calendars[strings.TrimPrefix(calendarURL, s.URL)]
	path := strings.TrimPrefix(calendarURL, s.URL) + name
	cal.objects[path] = &object{ics: ics, etag: s.nextETag()}
	return s.URL + path
}

// RemoveObject deletes an object as if another client had.
func (s *Server) RemoveObject(objectURL string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	path := strings.TrimPrefix(objectURL, s.URL)
	for _, cal := range s.calendars {
		if _, ok := cal.objects[path]; ok {
			delete(cal.objects, path)
			s.rev++
		}
	}
}

// Object returns the stored body of an object, or "" when absent.
func (s *Server) Object(objectURL string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	path := strings.TrimPrefix(objectURL, s.URL)
	for _, cal := range s.calendars {
		if o, ok := cal.objects[path]; ok {
			return o.ics
		}
	}
	return ""
}

// Objects returns every object body in a calendar, keyed by absolute URL.
func (s *Server) Objects(calendarURL string) map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]string{}
	if cal := s.calendars[strings.TrimPrefix(calendarURL, s.URL)]; cal != nil {
		for p, o := range cal.objects {
			out[s.URL+p] = o.ics
		}
	}
	return out
}

// Count returns how many requests of a method have been served.
func (s *Server) Count(method string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Requests[method]
}

func (s *Server) nextETag() string {
	s.rev++
	return fmt.Sprintf(`"rev-%d"`, s.rev)
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Requests[r.Method]++

	if s.Bearer != nil {
		tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || !s.Bearer(tok) {
			w.Header().Set("WWW-Authenticate", `Bearer realm="caldav"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
	} else if u, p, ok := r.BasicAuth(); !ok || u != s.Username || p != s.Password {
		w.Header().Set("WWW-Authenticate", `Basic realm="caldav"`)
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	body, _ := io.ReadAll(r.Body)
	path := r.URL.Path

	switch r.Method {
	case "PROPFIND":
		s.propfind(w, r, path)
	case "REPORT":
		s.report(w, path, string(body))
	case http.MethodGet:
		if o := s.find(path); o != nil {
			w.Header().Set("Content-Type", "text/calendar; charset=utf-8")
			w.Header().Set("ETag", o.etag)
			io.WriteString(w, o.ics)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	case http.MethodPut:
		s.put(w, r, path, string(body))
	case http.MethodDelete:
		s.delete(w, r, path)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *Server) find(path string) *object {
	for _, cal := range s.calendars {
		if o, ok := cal.objects[path]; ok {
			return o
		}
	}
	return nil
}

func (s *Server) calendarOf(path string) *calendar {
	for p, cal := range s.calendars {
		if strings.HasPrefix(path, p) {
			return cal
		}
	}
	return nil
}

func (s *Server) put(w http.ResponseWriter, r *http.Request, path, ics string) {
	cal := s.calendarOf(path)
	if cal == nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if cal.readOnly {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	existing := cal.objects[path]
	if r.Header.Get("If-None-Match") == "*" && existing != nil {
		w.WriteHeader(http.StatusPreconditionFailed)
		return
	}
	if m := r.Header.Get("If-Match"); m != "" && (existing == nil || existing.etag != m) {
		w.WriteHeader(http.StatusPreconditionFailed)
		return
	}
	o := &object{ics: ics, etag: s.nextETag()}
	cal.objects[path] = o
	w.Header().Set("ETag", o.etag)
	if existing == nil {
		w.WriteHeader(http.StatusCreated)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) delete(w http.ResponseWriter, r *http.Request, path string) {
	cal := s.calendarOf(path)
	if cal == nil || cal.objects[path] == nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if m := r.Header.Get("If-Match"); m != "" && cal.objects[path].etag != m {
		w.WriteHeader(http.StatusPreconditionFailed)
		return
	}
	delete(cal.objects, path)
	s.rev++
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) propfind(w http.ResponseWriter, r *http.Request, path string) {
	var b strings.Builder
	switch {
	case path == "/" || path == "/.well-known/caldav":
		b.WriteString(resp(path, `<d:current-user-principal><d:href>`+principalPath+`</d:href></d:current-user-principal>`))
	case path == principalPath:
		b.WriteString(resp(path, `<c:calendar-home-set><d:href>`+homePath+`</d:href></c:calendar-home-set>`))
	case path == homePath:
		b.WriteString(resp(path, `<d:resourcetype><d:collection/></d:resourcetype>`))
		if r.Header.Get("Depth") == "1" {
			paths := make([]string, 0, len(s.calendars))
			for p := range s.calendars {
				paths = append(paths, p)
			}
			sort.Strings(paths)
			for _, p := range paths {
				b.WriteString(resp(p, s.calendarProps(s.calendars[p])))
			}
		}
	default:
		cal, ok := s.calendars[path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		b.WriteString(resp(path, s.calendarProps(cal)))
	}
	writeMultistatus(w, b.String())
}

func (s *Server) calendarProps(cal *calendar) string {
	comp := "VEVENT"
	if cal.tasksOnly {
		comp = "VTODO"
	}
	priv := `<d:privilege><d:read/></d:privilege>`
	if !cal.readOnly {
		priv += `<d:privilege><d:write/></d:privilege>`
	}
	return `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>` +
		`<d:displayname>` + escape(cal.name) + `</d:displayname>` +
		`<cs:getctag>ctag-` + fmt.Sprint(s.rev) + `</cs:getctag>` +
		`<ic:calendar-color>` + cal.color + `</ic:calendar-color>` +
		`<c:supported-calendar-component-set><c:comp name="` + comp + `"/></c:supported-calendar-component-set>` +
		`<d:current-user-privilege-set>` + priv + `</d:current-user-privilege-set>`
}

func (s *Server) report(w http.ResponseWriter, path, body string) {
	cal, ok := s.calendars[path]
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	var b strings.Builder
	if strings.Contains(body, "calendar-multiget") {
		var req struct {
			Hrefs []string `xml:"DAV: href"`
		}
		_ = xml.Unmarshal([]byte(body), &req)
		for _, h := range req.Hrefs {
			// Real servers speak percent-encoded hrefs in both directions.
			if dec, err := url.PathUnescape(h); err == nil {
				h = dec
			}
			if o, ok := cal.objects[h]; ok {
				b.WriteString(resp(h, `<d:getetag>`+escape(o.etag)+`</d:getetag><c:calendar-data>`+escape(o.ics)+`</c:calendar-data>`))
			}
		}
	} else {
		paths := make([]string, 0, len(cal.objects))
		for p := range cal.objects {
			paths = append(paths, p)
		}
		sort.Strings(paths)
		for _, p := range paths {
			b.WriteString(resp(p, `<d:getetag>`+escape(cal.objects[p].etag)+`</d:getetag>`))
		}
	}
	writeMultistatus(w, b.String())
}

func resp(href, props string) string {
	return `<d:response><d:href>` + escape((&url.URL{Path: href}).EscapedPath()) + `</d:href><d:propstat><d:prop>` + props +
		`</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
}

func writeMultistatus(w http.ResponseWriter, inner string) {
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.WriteHeader(http.StatusMultiStatus)
	io.WriteString(w, `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" `+
		`xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" `+
		`xmlns:ic="http://apple.com/ns/ical/">`+inner+`</d:multistatus>`)
}

func escape(s string) string {
	var b strings.Builder
	xml.EscapeText(&b, []byte(s))
	return b.String()
}
