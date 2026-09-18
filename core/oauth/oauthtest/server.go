// Package oauthtest is a fake OAuth/OIDC provider for tests. It enforces the things a real one
// does — PKCE, redirect and client match, one-shot codes, refresh-token revocation — so a client
// that skips one fails here rather than in production.
package oauthtest

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"

	"companion/core/oauth"
)

// Server is the fake provider. Email/Subject describe the user who "signs in".
type Server struct {
	*httptest.Server
	ClientID, ClientSecret string
	Email, Subject, Name   string

	mu        sync.Mutex
	codes     map[string]pendingCode
	refresh   map[string][]string // refresh token → scopes
	access    map[string]bool
	n         int
	Refreshes int
}

type pendingCode struct {
	challenge, redirect, nonce string
	scopes                     []string
}

// New starts a provider for one client.
func New(clientID, clientSecret string) *Server {
	s := &Server{
		ClientID: clientID, ClientSecret: clientSecret,
		Email: "sam@example.com", Subject: "sub-1234", Name: "Sam Example",
		codes: map[string]pendingCode{}, refresh: map[string][]string{}, access: map[string]bool{},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/auth", s.authorize)
	mux.HandleFunc("/token", s.token)
	s.Server = httptest.NewServer(mux)
	return s
}

// Provider is the client-side configuration pointing at this server.
func (s *Server) Provider(redirectURI string) oauth.Provider {
	return oauth.Provider{
		ID: "google", AuthURL: s.URL + "/auth", TokenURL: s.URL + "/token",
		ClientID: s.ClientID, ClientSecret: s.ClientSecret, RedirectURI: redirectURI,
	}
}

// Approve plays the user: it "opens" the authorization URL, consents, and returns the redirect
// the browser would be sent to (with code and state).
func (s *Server) Approve(authURL string) (*url.URL, error) {
	hc := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := hc.Get(authURL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		return nil, fmt.Errorf("authorize returned %d", resp.StatusCode)
	}
	return url.Parse(resp.Header.Get("Location"))
}

// Revoke kills every refresh token, as when a user removes the app from their Google account.
func (s *Server) Revoke() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refresh = map[string][]string{}
	s.access = map[string]bool{}
}

// ExpireAccessTokens invalidates issued access tokens while leaving refresh tokens alive.
func (s *Server) ExpireAccessTokens() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.access = map[string]bool{}
}

// ValidAccessToken reports whether a bearer token is currently good (for a fake resource server).
func (s *Server) ValidAccessToken(tok string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.access[tok]
}

func (s *Server) authorize(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Get("client_id") != s.ClientID || q.Get("response_type") != "code" ||
		q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" || q.Get("state") == "" {
		http.Error(w, "bad authorization request", http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	s.n++
	code := fmt.Sprintf("code-%d", s.n)
	s.codes[code] = pendingCode{
		challenge: q.Get("code_challenge"), redirect: q.Get("redirect_uri"),
		nonce: q.Get("nonce"), scopes: strings.Fields(q.Get("scope")),
	}
	s.mu.Unlock()
	sep := "?"
	if strings.Contains(q.Get("redirect_uri"), "?") {
		sep = "&"
	}
	http.Redirect(w, r, q.Get("redirect_uri")+sep+url.Values{"code": {code}, "state": {q.Get("state")}}.Encode(), http.StatusFound)
}

func (s *Server) token(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	f := r.PostForm
	if f.Get("client_id") != s.ClientID || f.Get("client_secret") != s.ClientSecret {
		fail(w, "invalid_client")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch f.Get("grant_type") {
	case "authorization_code":
		pc, ok := s.codes[f.Get("code")]
		delete(s.codes, f.Get("code")) // one shot
		sum := sha256.Sum256([]byte(f.Get("code_verifier")))
		if !ok || pc.redirect != f.Get("redirect_uri") || base64.RawURLEncoding.EncodeToString(sum[:]) != pc.challenge {
			fail(w, "invalid_grant")
			return
		}
		s.n++
		rt := fmt.Sprintf("refresh-%d", s.n)
		s.refresh[rt] = pc.scopes
		s.issue(w, rt, pc.scopes, pc.nonce)
	case "refresh_token":
		scopes, ok := s.refresh[f.Get("refresh_token")]
		if !ok {
			fail(w, "invalid_grant")
			return
		}
		s.Refreshes++
		s.issue(w, "", scopes, "")
	default:
		fail(w, "unsupported_grant_type")
	}
}

func (s *Server) issue(w http.ResponseWriter, refresh string, scopes []string, nonce string) {
	s.n++
	at := fmt.Sprintf("access-%d", s.n)
	s.access[at] = true
	out := map[string]any{"access_token": at, "expires_in": 3600, "token_type": "Bearer", "scope": strings.Join(scopes, " ")}
	if refresh != "" {
		out["refresh_token"] = refresh
		claims, _ := json.Marshal(map[string]any{
			"iss": s.URL, "aud": s.ClientID, "sub": s.Subject, "email": s.Email,
			"email_verified": true, "name": s.Name, "nonce": nonce,
		})
		enc := base64.RawURLEncoding.EncodeToString
		out["id_token"] = enc([]byte(`{"alg":"none"}`)) + "." + enc(claims) + "." + enc([]byte("sig"))
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

func fail(w http.ResponseWriter, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadRequest)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code})
}
