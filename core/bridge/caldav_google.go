//go:build !js

package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"companion/core/caldav"
	"companion/core/domain"
	"companion/core/oauth"
	"companion/core/store"
)

// Google Calendar over CalDAV (PLAN-caldav.md §9). Google's endpoint speaks standard CalDAV but
// only accepts OAuth bearer tokens, so an account is created from an OAuth grant instead of a
// password. Everything after that — discovery, pull, conditional push — is the same engine.
//
// This file is the "calendar" purpose of the generic OAuth layer (oauth.go): it asks for the
// calendar scope on top of identity, and turns the grant into a CalendarAccount.

// GoogleCalendarScope is full read/write access to the user's calendars.
const GoogleCalendarScope = "https://www.googleapis.com/auth/calendar"

// googleCalDAVBase is Google's CalDAV root; a var so tests can point it at a fake.
var googleCalDAVBase = "https://apidata.googleusercontent.com/caldav/v2/"

const oauthPurposeCalendar = "calendar"

func (c *Core) registerPlatformOAuthPurposes() {
	c.registerOAuthPurpose(oauthPurposeCalendar, oauthPurpose{
		prepare:  (*Core).prepareCalendarGrant,
		complete: (*Core).completeCalendarGrant,
	})
}

type calendarGrantArgs struct {
	// AccountID reconnects an existing account (its grant expired or was revoked) instead of
	// adding a new one.
	AccountID string `json:"accountId"`
}

func (c *Core) prepareCalendarGrant(raw json.RawMessage) ([]string, string, error) {
	var args calendarGrantArgs
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return nil, "", err
		}
	}
	hint := ""
	if args.AccountID != "" {
		a, err := c.store.CalendarAccounts.Get(args.AccountID)
		if err != nil {
			return nil, "", mapStoreErr(err)
		}
		if !a.IsOAuth() {
			return nil, "", errors.New("this account signs in with a password")
		}
		hint = a.Username
	}
	return []string{GoogleCalendarScope}, hint, nil
}

func (c *Core) completeCalendarGrant(ctx context.Context, g *oauth.Grant, raw json.RawMessage) (any, error) {
	var args calendarGrantArgs
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &args)
	}
	switch {
	case !g.HasScope(GoogleCalendarScope):
		// Google's consent screen lets the user untick individual permissions.
		return nil, errors.New("Companion wasn't given access to your calendars. Try again and leave the calendar permission ticked.")
	case g.RefreshToken == "":
		return nil, errors.New("Google didn't return a long-lived sign-in. Remove Companion at myaccount.google.com/permissions and try again.")
	case g.Email == "":
		return nil, errors.New("Google didn't say which account signed in")
	}
	provider, _ := c.oauthProvider(g.Provider)

	// Reconnecting, or adding an account that is already here, updates it in place.
	existing, err := c.googleAccountFor(args.AccountID, g.Email)
	if err != nil {
		return nil, err
	}

	source := oauth.NewTokenSource(provider, g.RefreshToken, nil)
	source.Seed(g.AccessToken, g.Expiry)
	serverURL := googleCalDAVBase + url.PathEscape(g.Email) + "/user"
	client, err := caldav.NewWithAuth(serverURL, caldav.Bearer{Source: reauthAsUnauthorized{source}}, nil)
	if err != nil {
		return nil, err
	}
	home, err := client.Discover(ctx)
	if err != nil {
		return nil, errors.New(caldav.FriendlyError(err))
	}

	var a *domain.CalendarAccount
	created := existing == nil
	if created {
		a, err = c.store.CalendarAccounts.Create(store.CreateAccountInput{
			Name: "Google", ServerURL: serverURL, Username: g.Email, HomeSetURL: home,
			AuthKind: domain.CalendarAuthOAuthGoogle, OAuthClientID: g.ClientID,
		})
		if err != nil {
			return nil, err
		}
	} else {
		a = existing
	}
	enc, ref, err := c.storeCalendarCredential(a.ID, g.RefreshToken)
	if err == nil {
		a, err = c.store.CalendarAccounts.Update(a.ID, store.UpdateAccountInput{
			CredentialEnc: enc, CredentialRef: ref, OAuthClientID: &g.ClientID, HomeSetURL: &home,
		})
	}
	if err != nil {
		if created {
			_ = c.store.CalendarAccounts.Delete(a.ID)
		}
		return nil, err
	}
	c.cacheTokenSource(a.ID, source)

	engine := &caldav.Engine{Store: c.store}
	if _, err := engine.SyncCalendars(ctx, client, a); err != nil {
		if created {
			_ = c.store.CalendarAccounts.Delete(a.ID)
		}
		return nil, errors.New(caldav.FriendlyError(err))
	}
	_ = c.store.CalendarAccounts.SetLastError(a.ID, "")
	c.emitCalendarChanged("")
	return c.accountView(a)
}

// googleAccountFor finds the account a grant belongs to: the one being reconnected (which must be
// the same Google user — signing in as someone else must not silently repoint a calendar), or an
// existing account for that address.
func (c *Core) googleAccountFor(accountID, email string) (*domain.CalendarAccount, error) {
	if accountID != "" {
		a, err := c.store.CalendarAccounts.Get(accountID)
		if err != nil {
			return nil, mapStoreErr(err)
		}
		if !strings.EqualFold(a.Username, email) {
			return nil, fmt.Errorf("you signed in as %s, but this account is %s", email, a.Username)
		}
		return a, nil
	}
	accounts, err := c.store.CalendarAccounts.List()
	if err != nil {
		return nil, err
	}
	for _, a := range accounts {
		if a.AuthKind == domain.CalendarAuthOAuthGoogle && strings.EqualFold(a.Username, email) {
			return a, nil
		}
	}
	return nil, nil
}

// oauthCalDAVClient builds the client for an OAuth account, or errNoCredential when this device
// cannot act for it: no refresh token here, no client id in this build, or a token that belongs
// to another platform's client id (a refresh token only works with the client that obtained it).
func (c *Core) oauthCalDAVClient(a *domain.CalendarAccount, refreshToken string) (*caldav.Client, error) {
	provider, ok := c.oauthProvider(domain.OAuthProvider(a.AuthKind))
	if !ok || refreshToken == "" || provider.ClientID != a.OAuthClientID {
		return nil, errNoCredential
	}
	c.oauth.mu.Lock()
	source := c.oauth.sources[a.ID]
	if source == nil || source.RefreshToken() != refreshToken {
		source = oauth.NewTokenSource(provider, refreshToken, nil)
		c.oauth.sources[a.ID] = source
	}
	c.oauth.mu.Unlock()
	return caldav.NewWithAuth(a.ServerURL, caldav.Bearer{Source: reauthAsUnauthorized{source}}, nil)
}

func (c *Core) cacheTokenSource(accountID string, s *oauth.TokenSource) {
	c.oauth.mu.Lock()
	defer c.oauth.mu.Unlock()
	c.oauth.sources[accountID] = s
}

// reauthAsUnauthorized presents a dead refresh token to the CalDAV layer as what it is from that
// layer's point of view: the login no longer works.
type reauthAsUnauthorized struct{ *oauth.TokenSource }

func (r reauthAsUnauthorized) Token(ctx context.Context) (string, error) {
	tok, err := r.TokenSource.Token(ctx)
	if errors.Is(err, oauth.ErrReauthRequired) {
		return "", fmt.Errorf("%w: %v", caldav.ErrUnauthorized, err)
	}
	return tok, err
}
