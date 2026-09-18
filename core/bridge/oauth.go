package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"sync"
	"time"

	"companion/core/oauth"
)

// OAuth over the bridge (PLAN-caldav.md §9). This layer is deliberately not about calendars. A
// flow is started for a PURPOSE; the purpose says which extra scopes it needs and what to do with
// the resulting Grant. "calendar" (connect a Google calendar) is the only purpose today. Signing
// in to Companion with Google is meant to be the next, and needs nothing new here: register a
// "login" purpose whose handler hands grant.IDToken + grant.Nonce to the Companion server (which
// must verify the token itself — see oauth.ParseIDToken), and the same begin/complete/loopback
// machinery, the same provider config and the same UI helper carry it.
//
//	oauth.configure  shell → core: this build's client id for a provider
//	oauth.providers  which providers can be used here
//	oauth.begin      {provider, purpose, args} → {state, authUrl, loopback}
//	oauth.complete   {state, code} | {url}    (platforms without a loopback listener)
//	oauth.cancel     {state}
//	event oauth.done {state, purpose, ok, error?, result?}   (loopback flows finish by themselves)

const oauthDoneEvent = "oauth.done"

// oauthFlowTTL bounds how long a started flow waits for the user before it is forgotten.
const oauthFlowTTL = 10 * time.Minute

// oauthPurpose is one thing an OAuth grant can be used for.
type oauthPurpose struct {
	// prepare validates the purpose's args and says which scopes (beyond identity) to request
	// and which account to pre-select.
	prepare func(c *Core, args json.RawMessage) (scopes []string, loginHint string, err error)
	// complete consumes the grant and returns the JSON-able result the UI receives.
	complete func(c *Core, ctx context.Context, g *oauth.Grant, args json.RawMessage) (any, error)
}

type pendingOAuth struct {
	flow    *oauth.Flow
	purpose string
	args    json.RawMessage
	cancel  context.CancelFunc // non-nil for a loopback flow
}

// oauthState is the Core's OAuth bookkeeping, guarded by mu.
type oauthState struct {
	mu        sync.Mutex
	providers map[string]oauth.Provider
	purposes  map[string]oauthPurpose
	flows     map[string]*pendingOAuth
	sources   map[string]*oauth.TokenSource // by calendar account id
}

func newOAuthState() *oauthState {
	return &oauthState{
		providers: map[string]oauth.Provider{}, purposes: map[string]oauthPurpose{},
		flows: map[string]*pendingOAuth{}, sources: map[string]*oauth.TokenSource{},
	}
}

// SetOAuthProvider registers this build's configuration for a provider. Shells written in Go
// (desktop) call it directly; the others go through oauth.configure.
func (c *Core) SetOAuthProvider(p oauth.Provider) {
	c.oauth.mu.Lock()
	defer c.oauth.mu.Unlock()
	c.oauth.providers[p.ID] = p
}

func (c *Core) oauthProvider(id string) (oauth.Provider, bool) {
	c.oauth.mu.Lock()
	defer c.oauth.mu.Unlock()
	p, ok := c.oauth.providers[id]
	return p, ok && p.Configured()
}

func (c *Core) registerOAuthPurpose(name string, p oauthPurpose) {
	c.oauth.mu.Lock()
	defer c.oauth.mu.Unlock()
	c.oauth.purposes[name] = p
}

func (c *Core) oauthConfigure(payload []byte) ([]byte, error) {
	var args struct {
		Provider     string `json:"provider"`
		ClientID     string `json:"clientId"`
		ClientSecret string `json:"clientSecret"`
		RedirectURI  string `json:"redirectUri"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	switch args.Provider {
	case "google":
		c.SetOAuthProvider(oauth.Google(args.ClientID, args.ClientSecret, args.RedirectURI))
	default:
		return nil, errors.New("unknown oauth provider " + args.Provider)
	}
	return json.Marshal(map[string]bool{"ok": true})
}

func (c *Core) oauthProviders() ([]byte, error) {
	type view struct {
		ID         string `json:"id"`
		Configured bool   `json:"configured"`
	}
	c.oauth.mu.Lock()
	defer c.oauth.mu.Unlock()
	out := []view{}
	for id, p := range c.oauth.providers {
		out = append(out, view{ID: id, Configured: p.Configured()})
	}
	return json.Marshal(out)
}

func (c *Core) oauthBegin(payload []byte) ([]byte, error) {
	var args struct {
		Provider string          `json:"provider"`
		Purpose  string          `json:"purpose"`
		Args     json.RawMessage `json:"args"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	provider, ok := c.oauthProvider(args.Provider)
	if !ok {
		return nil, errors.New("signing in with " + args.Provider + " isn't set up in this build")
	}
	c.oauth.mu.Lock()
	purpose, ok := c.oauth.purposes[args.Purpose]
	c.oauth.mu.Unlock()
	if !ok {
		return nil, errors.New("this device can't use " + args.Provider + " sign-in for " + args.Purpose)
	}
	scopes, hint, err := purpose.prepare(c, args.Args)
	if err != nil {
		return nil, err
	}

	// A provider with a fixed redirect (mobile: a custom scheme) hands the code back through the
	// shell. Otherwise listen on loopback, where this platform can.
	var lb oauthLoopback
	redirect := provider.RedirectURI
	if redirect == "" {
		if lb, err = openOAuthLoopback(); err != nil {
			return nil, err
		}
		redirect = lb.RedirectURI()
	}
	flow, authURL, err := provider.Begin(redirect, scopes, hint)
	if err != nil {
		if lb != nil {
			lb.Close()
		}
		return nil, err
	}
	pending := &pendingOAuth{flow: flow, purpose: args.Purpose, args: args.Args}

	c.oauth.mu.Lock()
	for state, p := range c.oauth.flows { // forget abandoned flows
		if time.Since(p.flow.StartedAt) > oauthFlowTTL {
			if p.cancel != nil {
				p.cancel()
			}
			delete(c.oauth.flows, state)
		}
	}
	var ctx context.Context
	if lb != nil {
		ctx, pending.cancel = context.WithTimeout(context.Background(), oauthFlowTTL)
	}
	c.oauth.flows[flow.State] = pending
	c.oauth.mu.Unlock()

	if lb != nil {
		go c.oauthAwaitLoopback(ctx, lb, flow.State)
	}
	return json.Marshal(map[string]any{"state": flow.State, "authUrl": authURL, "loopback": lb != nil})
}

// oauthAwaitLoopback finishes a desktop flow on its own and reports through oauth.done.
func (c *Core) oauthAwaitLoopback(ctx context.Context, lb oauthLoopback, state string) {
	defer lb.Close()
	gotState, code, err := lb.Wait(ctx)
	var result any
	if err == nil {
		result, err = c.oauthFinish(ctx, state, gotState, code)
	} else {
		c.oauthForget(state)
	}
	if errors.Is(err, context.Canceled) {
		return // the user cancelled from the app; it already knows
	}
	c.emitOAuthDone(state, result, err)
}

func (c *Core) oauthComplete(payload []byte) ([]byte, error) {
	var args struct {
		State string `json:"state"`
		Code  string `json:"code"`
		// URL is the full redirect a shell received (a deep link); state/code are read from it.
		URL string `json:"url"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if args.URL != "" {
		u, err := url.Parse(args.URL)
		if err != nil {
			return nil, errors.New("that isn't a sign-in response")
		}
		q := u.Query()
		if e := q.Get("error"); e != "" {
			c.oauthForget(q.Get("state"))
			if e == "access_denied" {
				return nil, errors.New("sign-in was cancelled")
			}
			return nil, errors.New("sign-in failed (" + e + ")")
		}
		args.State, args.Code = q.Get("state"), q.Get("code")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	result, err := c.oauthFinish(ctx, args.State, args.State, args.Code)
	if err != nil {
		return nil, err
	}
	return json.Marshal(map[string]any{"ok": true, "result": result})
}

// oauthFinish exchanges the code and runs the purpose. A flow is single-use: it is removed
// before the exchange, so a replayed callback finds nothing.
func (c *Core) oauthFinish(ctx context.Context, state, gotState, code string) (any, error) {
	c.oauth.mu.Lock()
	pending, ok := c.oauth.flows[state]
	delete(c.oauth.flows, state)
	var purpose oauthPurpose
	if ok {
		purpose = c.oauth.purposes[pending.purpose]
	}
	c.oauth.mu.Unlock()
	if !ok || time.Since(pending.flow.StartedAt) > oauthFlowTTL {
		return nil, errors.New("that sign-in has expired — start again")
	}
	grant, err := pending.flow.Exchange(ctx, nil, gotState, code)
	if err != nil {
		return nil, err
	}
	return purpose.complete(c, ctx, grant, pending.args)
}

func (c *Core) oauthForget(state string) {
	c.oauth.mu.Lock()
	defer c.oauth.mu.Unlock()
	delete(c.oauth.flows, state)
}

func (c *Core) oauthCancel(payload []byte) ([]byte, error) {
	var args struct {
		State string `json:"state"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	c.oauth.mu.Lock()
	if p, ok := c.oauth.flows[args.State]; ok {
		if p.cancel != nil {
			p.cancel()
		}
		delete(c.oauth.flows, args.State)
	}
	c.oauth.mu.Unlock()
	return json.Marshal(map[string]bool{"ok": true})
}

func (c *Core) emitOAuthDone(state string, result any, err error) {
	out := map[string]any{"state": state, "ok": err == nil}
	if err != nil {
		out["error"] = err.Error()
	} else {
		out["result"] = result
	}
	payload, _ := json.Marshal(out)
	c.emit(oauthDoneEvent, payload)
}

// oauthLoopback is the desktop redirect listener (oauth.Loopback); an interface so the wasm build,
// which has no sockets, compiles without it.
type oauthLoopback interface {
	RedirectURI() string
	Wait(ctx context.Context) (state, code string, err error)
	Close()
}
