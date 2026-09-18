// Package oauth is Companion's OAuth 2.0 / OpenID Connect client: the authorization-code flow
// with PKCE, for installed apps. It knows nothing about calendars. A flow produces a Grant — who
// signed in, and tokens for the scopes that were asked for — and what a Grant is FOR is the
// caller's business. Connecting a Google calendar is the first use (PLAN-caldav.md §9); signing in
// to Companion with Google is meant to be the second, on exactly this code:
//
//   - every flow requests the identity scopes (openid email profile), so a Grant always says who;
//   - extra scopes (calendar) are added per purpose, never baked in;
//   - the raw ID token and the nonce bound to it are kept on the Grant, because a login has to
//     hand the ID token to the Companion server, which must verify it for itself.
//
// Secrets never pass through here in the clear on the wire to anyone but the provider: the code
// verifier stays on the device, and tokens are only ever sent to the provider's token endpoint.
package oauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var (
	// ErrReauthRequired means the refresh token no longer works (revoked, expired, password
	// changed). Only the user signing in again fixes it.
	ErrReauthRequired = errors.New("oauth: sign-in has expired or was revoked")
	// ErrNotConfigured means this build has no client id for the provider.
	ErrNotConfigured = errors.New("oauth: provider is not configured in this build")
	// ErrStateMismatch means a callback did not belong to the flow it claimed to.
	ErrStateMismatch = errors.New("oauth: response does not match the request")
)

// IdentityScopes are requested by every flow, whatever else it asks for, so that a Grant always
// identifies the user. This is what lets a "connect calendar" grant and a "sign in" grant be the
// same kind of thing.
var IdentityScopes = []string{"openid", "email", "profile"}

// Provider is one OAuth/OIDC identity provider, as configured for THIS app build. Client ids are
// per platform (Google issues a different one for desktop, iOS and Android), so each shell
// injects its own; a refresh token only works with the client id that obtained it.
type Provider struct {
	ID       string
	AuthURL  string
	TokenURL string
	ClientID string
	// ClientSecret is required by Google for "Desktop app" clients even with PKCE. It is not a
	// secret in any meaningful sense (it ships in the binary) and PKCE is what protects the flow.
	ClientSecret string
	// RedirectURI is the fixed redirect of a platform that cannot use a loopback listener
	// (mobile: a custom scheme). Empty on desktop, where a loopback port is picked per flow.
	RedirectURI string
	// AuthParams are provider-specific additions to the authorization request.
	AuthParams map[string]string
}

// Google returns the Google provider for a client id (and secret, for desktop clients).
func Google(clientID, clientSecret, redirectURI string) Provider {
	return Provider{
		ID:           "google",
		AuthURL:      "https://accounts.google.com/o/oauth2/v2/auth",
		TokenURL:     "https://oauth2.googleapis.com/token",
		ClientID:     clientID,
		ClientSecret: clientSecret,
		RedirectURI:  redirectURI,
		AuthParams: map[string]string{
			// offline + consent is what makes Google return a refresh token every time, not just
			// on the first authorization. include_granted_scopes lets a later flow (calendar after
			// login, or the reverse) add scopes to the same grant instead of replacing it.
			"access_type":            "offline",
			"prompt":                 "consent",
			"include_granted_scopes": "true",
		},
	}
}

// Configured reports whether the provider can be used.
func (p Provider) Configured() bool { return p.ClientID != "" && p.AuthURL != "" && p.TokenURL != "" }

// Flow is one authorization in progress. It holds the secrets that tie the response to the
// request (state, nonce, PKCE verifier) and never leaves the device.
type Flow struct {
	Provider    Provider
	State       string
	Nonce       string
	Verifier    string
	RedirectURI string
	Scopes      []string
	StartedAt   time.Time
}

// Begin starts a flow and returns the URL to open in the user's browser. scopes are added to the
// identity scopes; hint, when set, pre-selects an account (used when reconnecting one).
func (p Provider) Begin(redirectURI string, scopes []string, hint string) (*Flow, string, error) {
	if !p.Configured() {
		return nil, "", ErrNotConfigured
	}
	if redirectURI == "" {
		redirectURI = p.RedirectURI
	}
	if redirectURI == "" {
		return nil, "", errors.New("oauth: a redirect uri is required")
	}
	f := &Flow{
		Provider: p, State: randomToken(24), Nonce: randomToken(24), Verifier: randomToken(48),
		RedirectURI: redirectURI, Scopes: mergeScopes(IdentityScopes, scopes), StartedAt: time.Now(),
	}
	challenge := sha256.Sum256([]byte(f.Verifier))
	q := url.Values{
		"response_type":         {"code"},
		"client_id":             {p.ClientID},
		"redirect_uri":          {redirectURI},
		"scope":                 {strings.Join(f.Scopes, " ")},
		"state":                 {f.State},
		"nonce":                 {f.Nonce},
		"code_challenge":        {base64.RawURLEncoding.EncodeToString(challenge[:])},
		"code_challenge_method": {"S256"},
	}
	for k, v := range p.AuthParams {
		q.Set(k, v)
	}
	if hint != "" {
		q.Set("login_hint", hint)
	}
	sep := "?"
	if strings.Contains(p.AuthURL, "?") {
		sep = "&"
	}
	return f, p.AuthURL + sep + q.Encode(), nil
}

// Grant is the outcome of a flow: who signed in, and tokens for what was asked.
type Grant struct {
	Provider string
	// ClientID is the client the tokens belong to. A refresh token is useless with any other.
	ClientID string
	// Subject is the provider's stable id for the user — the key to store for a login, since an
	// email address can change.
	Subject       string
	Email         string
	EmailVerified bool
	Name          string
	AccessToken   string
	Expiry        time.Time
	RefreshToken  string
	// IDToken is the raw OIDC token and Nonce the value it is bound to. Unused by the calendar;
	// they are here for a server that has to verify the sign-in itself (see ParseIDToken).
	IDToken string
	Nonce   string
	Scopes  []string
}

// HasScope reports whether the provider actually granted a scope (the user can untick them).
func (g *Grant) HasScope(scope string) bool {
	for _, s := range g.Scopes {
		if s == scope {
			return true
		}
	}
	return false
}

// Exchange trades the authorization code for tokens. state is the value that came back on the
// redirect and must be this flow's.
func (f *Flow) Exchange(ctx context.Context, hc *http.Client, state, code string) (*Grant, error) {
	if state != f.State {
		return nil, ErrStateMismatch
	}
	if code == "" {
		return nil, errors.New("oauth: no authorization code was returned")
	}
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {f.RedirectURI},
		"client_id":     {f.Provider.ClientID},
		"code_verifier": {f.Verifier},
	}
	tok, err := f.Provider.token(ctx, hc, form)
	if err != nil {
		return nil, err
	}
	g := &Grant{
		Provider: f.Provider.ID, ClientID: f.Provider.ClientID,
		AccessToken: tok.AccessToken, Expiry: tok.expiry(), RefreshToken: tok.RefreshToken,
		IDToken: tok.IDToken, Nonce: f.Nonce, Scopes: strings.Fields(tok.Scope),
	}
	if len(g.Scopes) == 0 {
		g.Scopes = f.Scopes // a provider that omits scope granted what was asked
	}
	if tok.IDToken != "" {
		claims, err := ParseIDToken(tok.IDToken)
		if err != nil {
			return nil, err
		}
		if claims.Nonce != "" && claims.Nonce != f.Nonce {
			return nil, ErrStateMismatch
		}
		g.Subject, g.Email, g.EmailVerified, g.Name = claims.Subject, claims.Email, bool(claims.EmailVerified), claims.Name
	}
	return g, nil
}

// Claims are the ID token fields Companion reads.
type Claims struct {
	Issuer        string   `json:"iss"`
	Subject       string   `json:"sub"`
	Email         string   `json:"email"`
	EmailVerified flexBool `json:"email_verified"`
	Name          string   `json:"name"`
	Nonce         string   `json:"nonce"`
}

// ParseIDToken decodes an ID token's claims WITHOUT verifying its signature. That is sound only
// for a token this device received directly from the provider's token endpoint over TLS (OpenID
// Connect Core §3.1.3.7 allows the TLS server validation to stand in for the signature check).
// It is NOT sound anywhere else: a server handed an ID token by a client — a future Companion
// login — must verify the signature, issuer, audience, expiry and nonce itself.
func ParseIDToken(raw string) (*Claims, error) {
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		return nil, errors.New("oauth: malformed id token")
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return nil, fmt.Errorf("oauth: decode id token: %w", err)
	}
	var c Claims
	if err := json.Unmarshal(payload, &c); err != nil {
		return nil, fmt.Errorf("oauth: decode id token: %w", err)
	}
	return &c, nil
}

// flexBool accepts true and "true": providers disagree about email_verified.
type flexBool bool

func (b *flexBool) UnmarshalJSON(data []byte) error {
	*b = flexBool(strings.Trim(string(data), `"`) == "true")
	return nil
}

// ---- token endpoint ------------------------------------------------------

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	ExpiresIn    int64  `json:"expires_in"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`
	Scope        string `json:"scope"`
	Error        string `json:"error"`
	ErrorDesc    string `json:"error_description"`
}

func (t *tokenResponse) expiry() time.Time {
	if t.ExpiresIn <= 0 {
		return time.Now().Add(30 * time.Minute)
	}
	return time.Now().Add(time.Duration(t.ExpiresIn) * time.Second)
}

func (p Provider) token(ctx context.Context, hc *http.Client, form url.Values) (*tokenResponse, error) {
	if p.ClientSecret != "" {
		form.Set("client_secret", p.ClientSecret)
	}
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	var tok tokenResponse
	_ = json.Unmarshal(body, &tok)
	if resp.StatusCode != http.StatusOK || tok.Error != "" {
		if tok.Error == "invalid_grant" {
			return nil, ErrReauthRequired
		}
		// Deliberately not echoing the body: it can quote the request, tokens included.
		if tok.Error != "" {
			return nil, fmt.Errorf("oauth: %s refused the request (%s)", p.ID, tok.Error)
		}
		return nil, fmt.Errorf("oauth: %s token endpoint returned %d", p.ID, resp.StatusCode)
	}
	if tok.AccessToken == "" {
		return nil, fmt.Errorf("oauth: %s returned no access token", p.ID)
	}
	return &tok, nil
}

// ---- helpers -------------------------------------------------------------

func randomToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("oauth: no entropy: " + err.Error())
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func mergeScopes(a, b []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, list := range [][]string{a, b} {
		for _, s := range list {
			if s != "" && !seen[s] {
				seen[s] = true
				out = append(out, s)
			}
		}
	}
	return out
}
