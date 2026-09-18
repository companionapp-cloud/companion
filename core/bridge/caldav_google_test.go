package bridge

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"companion/core/caldav/caldavtest"
	"companion/core/domain"
	"companion/core/oauth/oauthtest"
	"companion/core/store"
)

// doneCatcher collects oauth.done payloads; events arrive from the loopback goroutine.
type doneCatcher struct {
	mu   sync.Mutex
	done []map[string]any
}

func (d *doneCatcher) OnEvent(name string, payload []byte) {
	if name != oauthDoneEvent {
		return
	}
	var m map[string]any
	_ = json.Unmarshal(payload, &m)
	d.mu.Lock()
	d.done = append(d.done, m)
	d.mu.Unlock()
}

func (d *doneCatcher) wait(t *testing.T, state string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		d.mu.Lock()
		for _, m := range d.done {
			if m["state"] == state {
				d.mu.Unlock()
				return m
			}
		}
		d.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("no oauth.done event")
	return nil
}

type googleFixture struct {
	idp      *oauthtest.Server
	provider *caldavtest.Server
	calendar string
	core     *Core
	events   *doneCatcher
	secrets  mapSecrets
}

func newGoogleFixture(t *testing.T) *googleFixture {
	t.Helper()
	idp := oauthtest.New("desktop-client", "not-really-secret")
	dav := caldavtest.New("", "")
	dav.Bearer = idp.ValidAccessToken // Google-style: bearer tokens only
	t.Cleanup(idp.Close)
	t.Cleanup(dav.Close)
	prev := googleCalDAVBase
	googleCalDAVBase = dav.URL + "/caldav/v2/"
	t.Cleanup(func() { googleCalDAVBase = prev })

	st, err := store.Open(":memory:", domain.SystemClock{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	f := &googleFixture{idp: idp, provider: dav, core: New(st), events: &doneCatcher{}, secrets: mapSecrets{}}
	f.core.SetEventHandler(f.events)
	f.core.SetSecretStore(f.secrets)
	f.calendar = dav.AddCalendar("primary", "Sam", "#4285F4", false)
	return f
}

// signIn runs a loopback flow end to end, playing the browser.
func (f *googleFixture) signIn(t *testing.T, args map[string]any) map[string]any {
	t.Helper()
	begin := invoke[struct {
		State, AuthURL string
		Loopback       bool
	}](t, f.core, "oauth.begin", map[string]any{"provider": "google", "purpose": "calendar", "args": args})
	if !begin.Loopback {
		t.Fatal("desktop flow should use the loopback listener")
	}
	back, err := f.idp.Approve(begin.AuthURL)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.Get(back.String())
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return f.events.wait(t, begin.State)
}

func TestGoogleCalendarOverOAuth(t *testing.T) {
	f := newGoogleFixture(t)
	c := f.core

	// Without a client id in the build, Google isn't offered and can't be started.
	if caps := invoke[map[string]bool](t, c, "calendar.capabilities", nil); caps["google"] {
		t.Fatal("google must not be offered before a client id is configured")
	}
	if _, err := c.Invoke("oauth.begin", []byte(`{"provider":"google","purpose":"calendar"}`)); err == nil {
		t.Fatal("begin should fail without configuration")
	}
	c.SetOAuthProvider(f.idp.Provider(""))
	if caps := invoke[map[string]bool](t, c, "calendar.capabilities", nil); !caps["google"] {
		t.Fatal("google should be offered once configured")
	}

	start := time.Now().UTC().Truncate(time.Hour).Add(24 * time.Hour)
	f.provider.PutObject(f.calendar, "e1.ics", fmt.Sprintf(
		"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Google//EN\r\nBEGIN:VEVENT\r\nUID:e1\r\nDTSTAMP:20260101T000000Z\r\n"+
			"DTSTART:%s\r\nSUMMARY:From Google\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n", start.Format("20060102T150405Z")))

	done := f.signIn(t, nil)
	if done["ok"] != true {
		t.Fatalf("sign-in failed: %v", done)
	}
	raw, _ := json.Marshal(done)
	if strings.Contains(string(raw), "refresh-") || strings.Contains(string(raw), "access-") {
		t.Fatalf("tokens must never reach the UI: %s", raw)
	}
	accounts := invoke[[]calendarAccountView](t, c, "calendar.accounts.list", nil)
	if len(accounts) != 1 || accounts[0].AuthKind != domain.CalendarAuthOAuthGoogle ||
		accounts[0].Username != "sam@example.com" || !accounts[0].HasCredential || len(accounts[0].Calendars) != 1 {
		t.Fatalf("account after sign-in: %+v", accounts)
	}
	stored, _ := c.store.CalendarAccounts.Get(accounts[0].ID)
	if stored.OAuthClientID != "desktop-client" || !strings.HasPrefix(f.secrets["caldav."+stored.ID], "refresh-") {
		t.Fatalf("refresh token and its client id should be stored: %+v / %v", stored, f.secrets)
	}

	// Pull and push with a bearer token.
	invoke[map[string]bool](t, c, "calendar.refresh", nil)
	items := calendarItems(t, c)
	if len(items) != 1 || items[0].Title != "From Google" || !items[0].Editable {
		t.Fatalf("after refresh: %+v", items)
	}
	invoke[map[string]any](t, c, "calendar.events.create", map[string]any{
		"feedId": accounts[0].Calendars[0].ID, "title": "Made in Companion", "startsAt": start.Add(2 * time.Hour),
	})
	invoke[map[string]any](t, c, "calendar.push", nil)
	if n := len(f.provider.Objects(f.calendar)); n != 2 {
		t.Fatalf("provider should hold 2 events, has %d", n)
	}

	// An access token expiring mid-session is refreshed transparently.
	f.idp.ExpireAccessTokens()
	before := f.idp.Refreshes
	invoke[map[string]any](t, c, "calendar.events.update", map[string]any{"id": items[0].SourceID, "title": "Renamed"})
	invoke[map[string]any](t, c, "calendar.push", nil)
	if !strings.Contains(f.provider.Object(f.calendar+"e1.ics"), "SUMMARY:Renamed") || f.idp.Refreshes != before+1 {
		t.Fatalf("expected one silent refresh and a successful push (refreshes %d→%d)", before, f.idp.Refreshes)
	}

	// Adding the same Google account again updates it rather than duplicating it.
	if done := f.signIn(t, nil); done["ok"] != true {
		t.Fatalf("second sign-in: %v", done)
	}
	if got := invoke[[]calendarAccountView](t, c, "calendar.accounts.list", nil); len(got) != 1 {
		t.Fatalf("same account added twice: %+v", got)
	}

	// Access removed at Google: the account says so, in words that fit an OAuth account.
	f.idp.Revoke()
	invoke[map[string]bool](t, c, "calendar.refresh", nil)
	got := invoke[[]calendarAccountView](t, c, "calendar.accounts.list", nil)
	if got[0].LastError == nil || !strings.Contains(*got[0].LastError, "Reconnect") {
		t.Fatalf("want a reconnect prompt, got %+v", got[0].LastError)
	}
	if _, err := c.Invoke("calendar.accounts.update", []byte(fmt.Sprintf(`{"id":%q,"password":"x"}`, got[0].ID))); err == nil {
		t.Fatal("an oauth account must not accept a password")
	}

	// Reconnecting as a DIFFERENT Google user must not repoint the account.
	f.idp.Email = "mallory@example.com"
	if done := f.signIn(t, map[string]any{"accountId": got[0].ID}); done["ok"] == true {
		t.Fatal("reconnect as another user should be refused")
	}
	f.idp.Email = "sam@example.com"
	if done := f.signIn(t, map[string]any{"accountId": got[0].ID}); done["ok"] != true {
		t.Fatalf("reconnect: %v", done)
	}
	invoke[map[string]bool](t, c, "calendar.refresh", nil)
	if got := invoke[[]calendarAccountView](t, c, "calendar.accounts.list", nil); got[0].LastError != nil {
		t.Fatalf("reconnect should clear the error: %v", *got[0].LastError)
	}
}

// Mobile has no loopback listener: the provider redirects to a custom scheme, the shell receives
// the deep link and hands it to oauth.complete. Same flow, same purpose, different last hop — and
// the shape a web "sign in with Google" will use too.
func TestOAuthManualCompletionAndSingleUse(t *testing.T) {
	f := newGoogleFixture(t)
	c := f.core
	invoke[map[string]bool](t, c, "oauth.configure", map[string]string{
		"provider": "google", "clientId": "x", "redirectUri": "com.example.app:/oauth2redirect",
	})
	// oauth.configure builds the real Google endpoints; swap in the fake ones for the test.
	c.SetOAuthProvider(f.idp.Provider("com.example.app:/oauth2redirect"))

	begin := invoke[struct {
		State, AuthURL string
		Loopback       bool
	}](t, c, "oauth.begin", map[string]any{"provider": "google", "purpose": "calendar"})
	if begin.Loopback {
		t.Fatal("a provider with a fixed redirect must not open a loopback listener")
	}
	back, err := f.idp.Approve(begin.AuthURL)
	if err != nil {
		t.Fatal(err)
	}
	res := invoke[struct {
		OK     bool
		Result calendarAccountView
	}](t, c, "oauth.complete", map[string]string{"url": back.String()})
	if !res.OK || res.Result.Username != "sam@example.com" {
		t.Fatalf("complete: %+v", res)
	}
	// A captured redirect replayed later finds no flow to complete.
	if _, err := c.Invoke("oauth.complete", []byte(fmt.Sprintf(`{"url":%q}`, back.String()))); err == nil {
		t.Fatal("a flow must be single-use")
	}
	// An unknown purpose is refused up front (the hook a future "login" purpose registers into).
	if _, err := c.Invoke("oauth.begin", []byte(`{"provider":"google","purpose":"login"}`)); err == nil {
		t.Fatal("unregistered purpose should be refused")
	}
}

// A refresh token belongs to the client id that obtained it, and client ids are per platform. A
// device built with a different one must stand aside rather than hammer Google with a token it
// cannot use.
func TestOAuthAccountFromAnotherPlatformIsLeftToThatPlatform(t *testing.T) {
	f := newGoogleFixture(t)
	c := f.core
	c.SetOAuthProvider(f.idp.Provider(""))
	if done := f.signIn(t, nil); done["ok"] != true {
		t.Fatalf("sign-in: %v", done)
	}
	// Same data, now seen from a build with the iOS client id.
	ios := f.idp.Provider("")
	ios.ClientID = "ios-client"
	c.SetOAuthProvider(ios)

	got := invoke[[]calendarAccountView](t, c, "calendar.accounts.list", nil)
	if got[0].HasCredential {
		t.Fatal("this build cannot use that grant and should say so")
	}
	before := f.idp.Refreshes
	f.idp.ExpireAccessTokens()
	invoke[map[string]bool](t, c, "calendar.refresh", nil)
	if f.idp.Refreshes != before {
		t.Fatal("must not try to refresh a token issued to another client")
	}
	if got := invoke[[]calendarAccountView](t, c, "calendar.accounts.list", nil); got[0].LastError != nil {
		t.Fatalf("standing aside is not an error: %v", *got[0].LastError)
	}
}
