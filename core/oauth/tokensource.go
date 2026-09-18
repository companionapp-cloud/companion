package oauth

import (
	"context"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// TokenSource turns a long-lived refresh token into short-lived access tokens, caching each until
// shortly before it expires. Safe for concurrent use.
type TokenSource struct {
	provider Provider
	refresh  string
	hc       *http.Client

	mu     sync.Mutex
	access string
	expiry time.Time
}

// NewTokenSource builds a source for a refresh token obtained with this provider's client id.
func NewTokenSource(p Provider, refreshToken string, hc *http.Client) *TokenSource {
	return &TokenSource{provider: p, refresh: refreshToken, hc: hc}
}

// Seed primes the cache with the access token a flow just returned, saving one round trip.
func (s *TokenSource) Seed(access string, expiry time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.access, s.expiry = access, expiry
}

// RefreshToken is the token this source was built for (so a cache can tell when it is stale).
func (s *TokenSource) RefreshToken() string { return s.refresh }

// Token returns a valid access token, refreshing if needed. ErrReauthRequired means the user has
// to sign in again.
func (s *TokenSource) Token(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.access != "" && time.Until(s.expiry) > time.Minute {
		return s.access, nil
	}
	if !s.provider.Configured() {
		return "", ErrNotConfigured
	}
	tok, err := s.provider.token(ctx, s.hc, url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {s.refresh},
		"client_id":     {s.provider.ClientID},
	})
	if err != nil {
		return "", err
	}
	s.access, s.expiry = tok.AccessToken, tok.expiry()
	return s.access, nil
}

// Invalidate drops the cached access token — the server said 401 to it — so the next Token call
// refreshes. Reports whether there was anything to drop, i.e. whether a retry can differ.
func (s *TokenSource) Invalidate() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	had := s.access != ""
	s.access = ""
	return had
}
