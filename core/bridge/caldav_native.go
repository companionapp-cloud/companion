//go:build !js

package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"companion/core/caldav"
	"companion/core/domain"
	"companion/core/store"
)

// Native clients talk to the CalDAV provider directly (PLAN-caldav.md §0): the sync server is
// never in the path, so it sees no credential, no calendar URL and no event.
const caldavSupported = true

// caldavMu serialises provider syncs. A refresh, a push and the post-sync hook can all ask at
// once; running them concurrently would only race each other into avoidable 412s.
var caldavMu sync.Mutex

const caldavTimeout = 2 * time.Minute

// calendarAccountsAdd verifies a login by discovering its calendars, then stores the account and
// one feed per calendar. Nothing is saved unless the provider accepted the credential.
func (c *Core) calendarAccountsAdd(payload []byte) ([]byte, error) {
	var args struct {
		Name      string `json:"name"`
		ServerURL string `json:"serverUrl"`
		Username  string `json:"username"`
		Password  string `json:"password"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if strings.TrimSpace(args.Password) == "" {
		return nil, errors.New("a password is required")
	}
	base, err := caldav.ParseServerURL(args.ServerURL)
	if err != nil {
		return nil, err
	}
	client, err := caldav.New(base.String(), args.Username, args.Password, nil)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), caldavTimeout)
	defer cancel()
	home, err := client.Discover(ctx)
	if err != nil {
		return nil, errors.New(caldav.FriendlyError(err))
	}

	name := strings.TrimSpace(args.Name)
	if name == "" {
		name = base.Hostname()
	}
	a, err := c.store.CalendarAccounts.Create(store.CreateAccountInput{
		Name: name, ServerURL: base.String(), Username: strings.TrimSpace(args.Username), HomeSetURL: home,
	})
	if err != nil {
		return nil, err
	}
	enc, ref, err := c.storeCalendarCredential(a.ID, args.Password)
	if err == nil {
		a, err = c.store.CalendarAccounts.Update(a.ID, store.UpdateAccountInput{CredentialEnc: enc, CredentialRef: ref})
	}
	if err != nil {
		_ = c.store.CalendarAccounts.Delete(a.ID)
		return nil, err
	}
	engine := &caldav.Engine{Store: c.store}
	if _, err := engine.SyncCalendars(ctx, client, a); err != nil {
		_ = c.store.CalendarAccounts.Delete(a.ID)
		return nil, errors.New(caldav.FriendlyError(err))
	}
	c.emitCalendarChanged("")
	v, err := c.accountView(a)
	if err != nil {
		return nil, err
	}
	return json.Marshal(v)
}

// calendarAccountsUpdate renames an account and/or replaces its password (after checking the new
// one works).
func (c *Core) calendarAccountsUpdate(payload []byte) ([]byte, error) {
	var args struct {
		ID       string  `json:"id"`
		Name     *string `json:"name"`
		Password string  `json:"password"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	a, err := c.store.CalendarAccounts.Get(args.ID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	in := store.UpdateAccountInput{Name: args.Name}
	if pw := strings.TrimSpace(args.Password); pw != "" {
		if a.IsOAuth() {
			return nil, errors.New("this account signs in with Google — reconnect it instead")
		}
		client, err := caldav.New(a.ServerURL, a.Username, pw, nil)
		if err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(context.Background(), caldavTimeout)
		defer cancel()
		if _, err := client.Discover(ctx); err != nil {
			return nil, errors.New(caldav.FriendlyError(err))
		}
		if in.CredentialEnc, in.CredentialRef, err = c.storeCalendarCredential(a.ID, pw); err != nil {
			return nil, err
		}
	}
	if a, err = c.store.CalendarAccounts.Update(a.ID, in); err != nil {
		return nil, mapStoreErr(err)
	}
	_ = c.store.CalendarAccounts.SetLastError(a.ID, "")
	c.emitCalendarChanged("")
	v, err := c.accountView(a)
	if err != nil {
		return nil, err
	}
	return json.Marshal(v)
}

// calendarAccountsRescan looks for calendars added on the provider since the account was set up.
func (c *Core) calendarAccountsRescan(payload []byte) ([]byte, error) {
	var args struct {
		ID string `json:"id"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	a, err := c.store.CalendarAccounts.Get(args.ID)
	if err != nil {
		return nil, mapStoreErr(err)
	}
	client, err := c.caldavClient(a)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), caldavTimeout)
	defer cancel()
	engine := &caldav.Engine{Store: c.store}
	if _, err := engine.SyncCalendars(ctx, client, a); err != nil {
		return nil, errors.New(caldav.FriendlyError(err))
	}
	c.emitCalendarChanged("")
	v, err := c.accountView(a)
	if err != nil {
		return nil, err
	}
	return json.Marshal(v)
}

// friendlyAccountError words a sync failure for the account it happened to: "wrong password" is
// the wrong advice for an account that has no password.
func friendlyAccountError(a *domain.CalendarAccount, err error) string {
	if a.IsOAuth() && errors.Is(err, caldav.ErrUnauthorized) {
		return "Companion's access to this Google account has expired or was removed. Reconnect it to keep syncing."
	}
	return caldav.FriendlyError(err)
}

// canSyncAccount reports whether THIS device can talk to the provider for the account.
func (c *Core) canSyncAccount(a *domain.CalendarAccount) bool {
	if !a.HasCredential() {
		return false
	}
	// A secret-store ref syncs with the row, but the secret behind it only exists on the device
	// it was entered on.
	if a.CredentialEnc == nil || *a.CredentialEnc == "" {
		if c.secrets == nil {
			return false
		}
		if v, err := c.secrets.GetSecret(*a.CredentialRef); err != nil || v == "" {
			return false
		}
	}
	if a.IsOAuth() {
		p, ok := c.oauthProvider(domain.OAuthProvider(a.AuthKind))
		return ok && p.ClientID == a.OAuthClientID
	}
	return true
}

// storeCalendarCredential decides where a password lives — the same rule as agent API keys. With
// E2EE unlocked it rides in the synced row (encrypted on the wire; every device can then write
// back). Without E2EE it stays in this device's secret store so it never syncs in the clear.
func (c *Core) storeCalendarCredential(accountID, password string) (enc *string, ref *string, err error) {
	if c.getMasterKey() != nil {
		return &password, nil, nil
	}
	r := "caldav." + accountID
	if err := c.storeSecret(r, password); err != nil {
		return nil, nil, err
	}
	return nil, &r, nil
}

// errNoCredential marks an account this device cannot act for. Not an error worth reporting: on an
// unencrypted account the password only exists on the device it was typed into.
var errNoCredential = errors.New("no credential on this device")

func (c *Core) caldavClient(a *domain.CalendarAccount) (*caldav.Client, error) {
	password := ""
	switch {
	case a.CredentialEnc != nil && *a.CredentialEnc != "":
		password = *a.CredentialEnc
	case a.CredentialRef != nil && *a.CredentialRef != "" && c.secrets != nil:
		p, err := c.secrets.GetSecret(*a.CredentialRef)
		if err != nil {
			return nil, fmt.Errorf("read calendar password: %w", err)
		}
		password = p
	}
	if a.IsOAuth() {
		// For an OAuth account the stored credential is a refresh token, not a password.
		return c.oauthCalDAVClient(a, password)
	}
	if password == "" {
		return nil, errNoCredential
	}
	return caldav.New(a.ServerURL, a.Username, password, nil)
}

// syncCalDAV runs the engine over every account this device holds a credential for. pushOnly
// skips calendars with nothing pending, which makes it cheap enough to call after each edit. One
// account failing is recorded on that account and does not stop the others.
func (c *Core) syncCalDAV(pushOnly bool) ([]caldav.Conflict, error) {
	caldavMu.Lock()
	defer caldavMu.Unlock()

	accounts, err := c.store.CalendarAccounts.List()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), caldavTimeout)
	defer cancel()
	engine := &caldav.Engine{Store: c.store}
	conflicts := []caldav.Conflict{}

	for _, a := range accounts {
		client, err := c.caldavClient(a)
		if errors.Is(err, errNoCredential) {
			continue
		}
		if err == nil {
			err = c.syncCalDAVAccount(ctx, engine, client, a, pushOnly, &conflicts)
		}
		if err != nil {
			log.Printf("calendar: sync account %s: %v", a.ID, err)
		}
		if serr := c.store.CalendarAccounts.SetLastError(a.ID, friendlyAccountError(a, err)); serr != nil {
			return conflicts, serr
		}
	}
	if len(conflicts) > 0 {
		payload, _ := json.Marshal(map[string]any{"conflicts": conflicts})
		c.emit(calendarConflictEvent, payload)
	}
	return conflicts, nil
}

func (c *Core) syncCalDAVAccount(ctx context.Context, engine *caldav.Engine, client *caldav.Client,
	a *domain.CalendarAccount, pushOnly bool, conflicts *[]caldav.Conflict) error {
	feeds, err := c.store.CalendarFeeds.ListByAccount(a.ID)
	if err != nil {
		return err
	}
	// An account with no calendars attached is never what the user set up: its feeds lost their
	// link (see CalendarFeedsRepo.Apply). Rediscover, which re-adopts them and collapses any
	// duplicates, instead of silently syncing nothing forever.
	if len(feeds) == 0 && !pushOnly {
		if feeds, err = engine.SyncCalendars(ctx, client, a); err != nil {
			return err
		}
	}
	for _, f := range feeds {
		if pushOnly {
			pending, err := c.store.CalendarObjects.Pending(f.ID)
			if err != nil {
				return err
			}
			if len(pending) == 0 {
				continue
			}
		}
		res, err := engine.SyncFeed(ctx, client, f)
		*conflicts = append(*conflicts, res.Conflicts...)
		if err != nil {
			return err
		}
	}
	return nil
}

// pushCalDAVAfterSync runs after a sync pull. If the pull delivered changes another client could
// not push itself (the web app, or a device without the password), this device does it for them,
// then syncs the outcome back. Off the critical path: sync has already returned to the UI.
func (c *Core) pushCalDAVAfterSync() {
	pending, err := c.store.CalendarObjects.HasPending()
	if err != nil || !pending {
		return
	}
	go func() {
		if _, err := c.syncCalDAV(true); err != nil {
			log.Printf("calendar: push after sync: %v", err)
			return
		}
		if c.sync.baseURL != "" {
			if err := c.newSyncEngine().Sync(); err != nil {
				log.Printf("calendar: sync after push: %v", err)
			}
		}
		c.emitCalendarChanged("")
	}()
}
