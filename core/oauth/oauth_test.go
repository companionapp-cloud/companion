package oauth_test

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"companion/core/oauth"
	"companion/core/oauth/oauthtest"
)

var ctx = context.Background()

const calendarScope = "https://www.googleapis.com/auth/calendar"

func TestFlowProducesAnIdentifiedGrant(t *testing.T) {
	s := oauthtest.New("client-1", "shh")
	defer s.Close()
	p := s.Provider("app://callback")

	flow, authURL, err := p.Begin("", []string{calendarScope}, "sam@example.com")
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(authURL)
	q := u.Query()
	if q.Get("code_challenge_method") != "S256" || q.Get("state") != flow.State || q.Get("nonce") != flow.Nonce {
		t.Fatalf("authorization request is missing PKCE/state/nonce: %v", q)
	}
	if strings.Contains(authURL, flow.Verifier) {
		t.Fatal("the PKCE verifier must never appear in the authorization URL")
	}
	// Identity scopes ride along with every flow, so any grant can later serve a login.
	for _, want := range []string{"openid", "email", "profile", calendarScope} {
		if !strings.Contains(" "+q.Get("scope")+" ", " "+want+" ") {
			t.Errorf("scope %q missing from %q", want, q.Get("scope"))
		}
	}
	if q.Get("login_hint") != "sam@example.com" {
		t.Errorf("login hint not passed")
	}

	back, err := s.Approve(authURL)
	if err != nil {
		t.Fatal(err)
	}
	g, err := flow.Exchange(ctx, nil, back.Query().Get("state"), back.Query().Get("code"))
	if err != nil {
		t.Fatal(err)
	}
	if g.Subject != "sub-1234" || g.Email != "sam@example.com" || !g.EmailVerified || g.Name != "Sam Example" {
		t.Errorf("identity not read from the id token: %+v", g)
	}
	if g.RefreshToken == "" || g.AccessToken == "" || g.ClientID != "client-1" || !g.HasScope(calendarScope) {
		t.Errorf("tokens/scopes missing: %+v", g)
	}
	// What a future server-side login needs to verify the sign-in for itself.
	if g.IDToken == "" || g.Nonce != flow.Nonce {
		t.Errorf("raw id token and nonce must be kept on the grant")
	}
}

func TestExchangeRejectsForeignState(t *testing.T) {
	s := oauthtest.New("client-1", "")
	defer s.Close()
	flow, authURL, _ := s.Provider("app://cb").Begin("", nil, "")
	back, _ := s.Approve(authURL)
	if _, err := flow.Exchange(ctx, nil, "someone-elses-state", back.Query().Get("code")); !errors.Is(err, oauth.ErrStateMismatch) {
		t.Fatalf("want ErrStateMismatch, got %v", err)
	}
}

func TestStolenCodeIsUselessWithoutTheVerifier(t *testing.T) {
	s := oauthtest.New("client-1", "")
	defer s.Close()
	p := s.Provider("app://cb")
	victim, authURL, _ := p.Begin("", nil, "")
	back, _ := s.Approve(authURL)
	// An attacker who intercepts the redirect has the code and state but not the verifier.
	thief := *victim
	thief.Verifier = "guessed"
	if _, err := thief.Exchange(ctx, nil, back.Query().Get("state"), back.Query().Get("code")); err == nil {
		t.Fatal("PKCE should have stopped a code exchange without the verifier")
	}
}

func TestUnconfiguredProvider(t *testing.T) {
	if _, _, err := oauth.Google("", "", "").Begin("http://127.0.0.1:1", nil, ""); !errors.Is(err, oauth.ErrNotConfigured) {
		t.Fatalf("want ErrNotConfigured, got %v", err)
	}
	g := oauth.Google("id", "secret", "")
	if !g.Configured() || g.AuthParams["access_type"] != "offline" {
		t.Errorf("google preset: %+v", g)
	}
}

func TestTokenSourceCachesRefreshesAndReportsRevocation(t *testing.T) {
	s := oauthtest.New("client-1", "shh")
	defer s.Close()
	p := s.Provider("app://cb")
	flow, authURL, _ := p.Begin("", nil, "")
	back, _ := s.Approve(authURL)
	g, err := flow.Exchange(ctx, nil, back.Query().Get("state"), back.Query().Get("code"))
	if err != nil {
		t.Fatal(err)
	}

	ts := oauth.NewTokenSource(p, g.RefreshToken, nil)
	ts.Seed(g.AccessToken, g.Expiry)
	a, _ := ts.Token(ctx)
	b, _ := ts.Token(ctx)
	if a != g.AccessToken || a != b || s.Refreshes != 0 {
		t.Fatalf("a seeded, unexpired token should be reused without a refresh (refreshes=%d)", s.Refreshes)
	}
	if !ts.Invalidate() {
		t.Fatal("Invalidate should report there was a token to drop")
	}
	c, err := ts.Token(ctx)
	if err != nil || c == a || s.Refreshes != 1 {
		t.Fatalf("after invalidation a fresh token is fetched: %q %v refreshes=%d", c, err, s.Refreshes)
	}
	if ts.Invalidate(); ts.Invalidate() {
		t.Error("a second Invalidate has nothing to drop, so a retry would be pointless")
	}

	s.Revoke()
	if _, err := ts.Token(ctx); !errors.Is(err, oauth.ErrReauthRequired) {
		t.Fatalf("a revoked refresh token must surface as ErrReauthRequired, got %v", err)
	}
}

func TestLoopbackDeliversTheRedirectOnce(t *testing.T) {
	s := oauthtest.New("client-1", "")
	defer s.Close()
	lb, err := oauth.ListenLoopback()
	if err != nil {
		t.Fatal(err)
	}
	defer lb.Close()
	if !strings.HasPrefix(lb.RedirectURI(), "http://127.0.0.1:") {
		t.Fatalf("loopback must bind 127.0.0.1 only, got %s", lb.RedirectURI())
	}
	flow, authURL, _ := s.Provider("").Begin(lb.RedirectURI(), nil, "")
	back, _ := s.Approve(authURL)

	resp, err := http.Get(back.String()) // the browser following the redirect
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	wctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	state, code, err := lb.Wait(wctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := flow.Exchange(ctx, nil, state, code); err != nil {
		t.Fatalf("exchange via loopback: %v", err)
	}
}

func TestLoopbackReportsCancellation(t *testing.T) {
	lb, _ := oauth.ListenLoopback()
	defer lb.Close()
	resp, err := http.Get(lb.RedirectURI() + "/?error=access_denied&state=x")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	wctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if _, _, err := lb.Wait(wctx); err == nil || !strings.Contains(err.Error(), "cancelled") {
		t.Fatalf("want a cancellation error, got %v", err)
	}
}
