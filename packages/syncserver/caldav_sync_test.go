package syncserver

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"companion/core/caldav"
	"companion/core/caldav/caldavtest"
	"companion/core/calendar"
	"companion/core/crypto"
	"companion/core/domain"
	"companion/core/store"
	"companion/core/sync/protocol"
)

// The whole point of the CalDAV design (PLAN-caldav.md §0), in one test:
//
//   - a desktop adds a CalDAV account and pulls a calendar;
//   - the account, its password and its events reach a web client through the sync server, which
//     stores nothing but ciphertext;
//   - the web client — which can never talk to the provider — creates an event;
//   - the desktop receives that pending row through sync and writes it to the provider.
func TestCalDAVWebEditIsPushedByNativeDeviceThroughAnOpaqueServer(t *testing.T) {
	ts, srv := newServerAPI(t)
	token := register(t, ts.URL, "caldav@b.co", "password")
	cipher := crypto.NewCipher(mustKey(t))
	desktop := newClient(t, ts.URL, token, "desktop")
	desktop.engine.SetCipher(cipher)
	web := newClient(t, ts.URL, token, "web")
	web.engine.SetCipher(cipher)

	provider := caldavtest.New("sam@example.com", "app-specific-pw")
	defer provider.Close()
	cal := provider.AddCalendar("home", "Home", "#AA5500", false)
	start := base.Add(48 * time.Hour)
	end := start.Add(time.Hour)
	existing, _ := calendar.NewObject("EXISTING", calendar.EventFields{Title: "Oncology follow-up", StartsAt: start, EndsAt: &end}, base)
	provider.PutObject(cal, "existing.ics", existing)

	// Desktop: add the account (credential in the row, as on an E2EE account) and pull.
	ctx := context.Background()
	pw := "app-specific-pw"
	acct, err := desktop.store.CalendarAccounts.Create(store.CreateAccountInput{
		Name: "iCloud", ServerURL: provider.URL, Username: "sam@example.com", CredentialEnc: &pw,
	})
	if err != nil {
		t.Fatal(err)
	}
	dav, _ := caldav.New(provider.URL, "sam@example.com", pw, nil)
	engine := &caldav.Engine{Store: desktop.store, Now: func() time.Time { return base }}
	feeds, err := engine.SyncCalendars(ctx, dav, acct)
	if err != nil || len(feeds) != 1 {
		t.Fatalf("discover: %+v %v", feeds, err)
	}
	if _, err := engine.SyncFeed(ctx, dav, feeds[0]); err != nil {
		t.Fatal(err)
	}
	if err := desktop.engine.Sync(); err != nil {
		t.Fatalf("desktop sync: %v", err)
	}

	// The server holds the account and the event, and can read neither.
	for table, secrets := range map[string][]string{
		"calendar_accounts": {"app-specific-pw", "sam@example.com", provider.URL, "iCloud"},
		"calendar_objects":  {"Oncology", "EXISTING", "existing.ics"},
	} {
		rows, err := srv.query(`SELECT row_json FROM ` + table + `;`)
		if err != nil {
			t.Fatal(err)
		}
		n := 0
		for rows.Next() {
			var body string
			rows.Scan(&body)
			n++
			for _, secret := range secrets {
				if strings.Contains(body, secret) {
					t.Errorf("%s: %q is readable on the server:\n%s", table, secret, body)
				}
			}
		}
		rows.Close()
		if n != 1 {
			t.Fatalf("%s: want 1 row on the server, got %d", table, n)
		}
	}
	var feedURL, feedKind string
	if err := srv.queryRow(`SELECT url, kind FROM calendar_feeds WHERE id = ?;`, feeds[0].ID).Scan(&feedURL, &feedKind); err != nil {
		t.Fatal(err)
	}
	if !crypto.IsEnvelope(feedURL) || feedKind != domain.FeedKindCalDAV {
		t.Fatalf("calendar url must be ciphertext and kind plaintext, got %q / %q", feedURL, feedKind)
	}

	// Web: receives everything decrypted, sees an editable event.
	if err := web.engine.Sync(); err != nil {
		t.Fatalf("web sync: %v", err)
	}
	items, _ := web.store.CalendarEvents.Range(base, base.Add(7*24*time.Hour))
	if len(items) != 1 || items[0].Title != "Oncology follow-up" || !items[0].Editable {
		t.Fatalf("web calendar: %+v", items)
	}
	webAcct, err := web.store.CalendarAccounts.Get(acct.ID)
	if err != nil || webAcct.CredentialEnc == nil || *webAcct.CredentialEnc != pw {
		t.Fatalf("the credential should reach the user's other devices decrypted: %+v %v", webAcct, err)
	}

	// Web creates an event. It cannot reach the provider; it only writes rows.
	web.clk.t = base.Add(time.Minute)
	newStart := start.Add(3 * time.Hour)
	ics, _ := calendar.NewObject("FROM-WEB", calendar.EventFields{Title: "Made on the web", StartsAt: newStart}, web.clk.t)
	obj := &domain.CalendarObject{
		ID: calendar.ObjectID(feeds[0].ID, "FROM-WEB"), FeedID: feeds[0].ID, UID: "FROM-WEB",
		ICS: ics, PushState: domain.PushPendingCreate,
	}
	if err := web.store.CalendarObjects.Put(obj); err != nil {
		t.Fatal(err)
	}
	if _, err := web.store.CalendarEvents.DeriveFromObject(obj); err != nil {
		t.Fatal(err)
	}
	if err := web.engine.Sync(); err != nil {
		t.Fatalf("web sync 2: %v", err)
	}
	if n := len(provider.Objects(cal)); n != 1 {
		t.Fatalf("nothing should have reached the provider yet, has %d", n)
	}

	// Desktop: pulls the pending row and pushes it on the web client's behalf.
	if err := desktop.engine.Sync(); err != nil {
		t.Fatalf("desktop sync 2: %v", err)
	}
	if pending, _ := desktop.store.CalendarObjects.HasPending(); !pending {
		t.Fatal("desktop should have received a pending object")
	}
	desktop.clk.t = base.Add(2 * time.Minute)
	res, err := engine.SyncFeed(ctx, dav, feeds[0])
	if err != nil || res.Pushed != 1 || len(res.Conflicts) != 0 {
		t.Fatalf("desktop push: %+v %v", res, err)
	}
	if !strings.Contains(provider.Object(caldav.ObjectURL(cal, "FROM-WEB")), "SUMMARY:Made on the web") {
		t.Fatalf("provider never received the web client's event: %v", provider.Objects(cal))
	}

	// And the outcome flows back: the web client sees its event confirmed.
	if err := desktop.engine.Sync(); err != nil {
		t.Fatalf("desktop sync 3: %v", err)
	}
	if err := web.engine.Sync(); err != nil {
		t.Fatalf("web sync 3: %v", err)
	}
	got, err := web.store.CalendarObjects.Get(obj.ID)
	if err != nil || got.PushState != domain.PushSynced || got.ETag == "" || got.Href == "" {
		t.Fatalf("web should see the event as synced: %+v %v", got, err)
	}
	items, _ = web.store.CalendarEvents.Range(base, base.Add(7*24*time.Hour))
	if len(items) != 2 || items[1].Pending {
		t.Fatalf("web calendar after round trip: %+v", items)
	}
}

// A client from before CalDAV has no notion of a feed's kind: it pushes feeds without one. When
// such a client renames a calendar, the server must keep the row's CalDAV identity, and a current
// client must keep its own when an old SERVER echoes a feed back without it. Losing it is what
// once orphaned every calendar and made each rescan create them all again.
func TestOldClientOrServerCannotStripCalDAVIdentity(t *testing.T) {
	ts, srv := newServerAPI(t)
	token := register(t, ts.URL, "strip@b.co", "password")
	desktop := newClient(t, ts.URL, token, "desktop")

	acct, _ := desktop.store.CalendarAccounts.Create(store.CreateAccountInput{Name: "iCloud", ServerURL: "https://caldav.icloud.com/", Username: "sam"})
	feed, err := desktop.store.CalendarFeeds.Create(store.CreateFeedInput{
		Name: "Home", URL: "https://p1-caldav.icloud.com/1/calendars/home/", Kind: domain.FeedKindCalDAV, AccountID: &acct.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := desktop.engine.Sync(); err != nil {
		t.Fatal(err)
	}

	// An old phone renames the calendar: same row, no kind/accountId/readOnly fields at all.
	old, _ := json.Marshal(map[string]any{
		"id": feed.ID, "name": "Home (renamed on old phone)", "url": feed.URL,
		"createdAt": feed.CreatedAt, "updatedAt": base.Add(time.Hour), "version": 1,
	})
	body := protocol.PushRequest{Changes: []protocol.PushChange{{
		EntityType: protocol.EntityCalendarFeed, ID: feed.ID, BaseVersion: 1, Row: old, UpdatedAt: base.Add(time.Hour),
	}}}
	res, err := http.DefaultClient.Do(authedReq(t, http.MethodPost, ts.URL+"/v1/sync/push", token, "old-phone", body))
	if err != nil || res.StatusCode != http.StatusOK {
		t.Fatalf("old-client push: %v %v", res, err)
	}
	res.Body.Close()

	var kind, name string
	var account sql.NullString
	if err := srv.queryRow(`SELECT kind, account_id, name FROM calendar_feeds WHERE id = ?;`, feed.ID).Scan(&kind, &account, &name); err != nil {
		t.Fatal(err)
	}
	if kind != domain.FeedKindCalDAV || account.String != acct.ID || !strings.Contains(name, "renamed") {
		t.Fatalf("server should take the rename and keep the identity: kind=%q account=%q name=%q", kind, account.String, name)
	}

	// The rename reaches the desktop with its identity intact…
	if err := desktop.engine.Sync(); err != nil {
		t.Fatal(err)
	}
	got, _ := desktop.store.CalendarFeeds.Get(feed.ID)
	if !got.IsCalDAV() || got.AccountID == nil || *got.AccountID != acct.ID || !strings.Contains(got.Name, "renamed") {
		t.Fatalf("desktop feed after the old client's rename: %+v", got)
	}
	// …and even a row that arrives with no kind (an old server's echo) cannot strip it locally.
	stripped := *got
	stripped.Kind, stripped.AccountID, stripped.ReadOnly = "", nil, false
	if err := desktop.store.CalendarFeeds.Apply(&stripped); err != nil {
		t.Fatal(err)
	}
	if got, _ := desktop.store.CalendarFeeds.Get(feed.ID); !got.IsCalDAV() || got.AccountID == nil {
		t.Fatalf("a kindless row must not orphan a CalDAV calendar: %+v", got)
	}
}
