package syncserver

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"companion/core/crypto"
	"companion/core/domain"
	"companion/core/store"
)

// authedJSON performs a bearer-authenticated request with an optional JSON body, returning the
// response for status assertions and decoding into out when non-nil.
func authedJSON(t *testing.T, method, url, token string, body, out any) *http.Response {
	t.Helper()
	var r *bytes.Reader
	if body != nil {
		buf, _ := json.Marshal(body)
		r = bytes.NewReader(buf)
	} else {
		r = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, url, r)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	if out != nil {
		json.NewDecoder(resp.Body).Decode(out)
	}
	resp.Body.Close()
	return resp
}

// TestKeyStorageRoundTrip covers the blind-custodian contract: no key until one is stored (404),
// PUT accepts wrapped material, and GET returns exactly what was stored.
func TestKeyStorageRoundTrip(t *testing.T) {
	ts := newServer(t)
	token := register(t, ts.URL, "keys@b.co", "password")

	// No key yet → 404 (the "plaintext account" signal).
	if resp := authedJSON(t, http.MethodGet, ts.URL+"/v1/keys", token, nil, nil); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("GET keys before setup = %d, want 404", resp.StatusCode)
	}

	km := keyMaterial{
		WrappedMasterKey: "enc$v1$" + "AAAABBBBCCCC",
		KDFSalt:          "c2FsdHNhbHQ",
		KDFTime:          3,
		KDFMemoryK:       65536,
		KDFThreads:       4,
		RecoveryWrapped:  "enc$v1$" + "DDDDEEEE",
	}
	if resp := authedJSON(t, http.MethodPut, ts.URL+"/v1/keys", token, km, nil); resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT keys = %d, want 200", resp.StatusCode)
	}

	var got keyMaterial
	if resp := authedJSON(t, http.MethodGet, ts.URL+"/v1/keys", token, nil, &got); resp.StatusCode != http.StatusOK {
		t.Fatalf("GET keys = %d, want 200", resp.StatusCode)
	}
	if got != km {
		t.Fatalf("round trip mismatch:\n got  %+v\n want %+v", got, km)
	}

	// PUT with missing fields is rejected.
	if resp := authedJSON(t, http.MethodPut, ts.URL+"/v1/keys", token, keyMaterial{WrappedMasterKey: "x"}, nil); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("PUT keys with bad params = %d, want 400", resp.StatusCode)
	}
}

// TestKeysAreScopedPerUser ensures one account can't read another's key material.
func TestKeysAreScopedPerUser(t *testing.T) {
	ts := newServer(t)
	tokA := register(t, ts.URL, "a-keys@b.co", "password")
	tokB := register(t, ts.URL, "b-keys@b.co", "password")

	km := keyMaterial{WrappedMasterKey: "enc$v1$AAAA", KDFSalt: "c2FsdA", KDFTime: 1, KDFMemoryK: 8192, KDFThreads: 1}
	authedJSON(t, http.MethodPut, ts.URL+"/v1/keys", tokA, km, nil)

	// B has stored nothing → still 404, even though A has a key.
	if resp := authedJSON(t, http.MethodGet, ts.URL+"/v1/keys", tokB, nil, nil); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("B GET keys = %d, want 404 (must not see A's key)", resp.StatusCode)
	}
}

// TestEncryptedSyncServerStoresCiphertext is the end-to-end server guarantee: content pushed by an
// encryption-enabled client is stored as ciphertext in the database (the operator can't read it),
// yet a second device with the key converges to the original plaintext.
func TestEncryptedSyncServerStoresCiphertext(t *testing.T) {
	ts, srv := newServerAPI(t)
	token := register(t, ts.URL, "e2e@b.co", "password")

	master, _ := crypto.NewMasterKey()
	cipher := crypto.NewCipher(master)

	a := newClient(t, ts.URL, token, "devA")
	a.engine.SetCipher(cipher)
	b := newClient(t, ts.URL, token, "devB")
	b.engine.SetCipher(cipher)

	note, _ := a.store.Notes.Create(store.CreateNoteInput{Title: "Salary review", ContentMD: "# confidential"})
	if err := a.engine.Sync(); err != nil {
		t.Fatalf("A sync: %v", err)
	}

	// Inspect the raw database column: the server must hold ciphertext, not the title.
	var storedTitle, storedContent string
	if err := srv.queryRow(`SELECT title, content_md FROM notes WHERE id = ?;`, note.ID).Scan(&storedTitle, &storedContent); err != nil {
		t.Fatalf("read stored note: %v", err)
	}
	if strings.Contains(storedTitle, "Salary") || strings.Contains(storedContent, "confidential") {
		t.Fatalf("server stored plaintext! title=%q content=%q", storedTitle, storedContent)
	}
	if !crypto.IsEnvelope(storedTitle) || !crypto.IsEnvelope(storedContent) {
		t.Fatalf("server should store enc$v1$ envelopes, got title=%q", storedTitle)
	}

	// Device B converges to the real plaintext.
	if err := b.engine.Sync(); err != nil {
		t.Fatalf("B sync: %v", err)
	}
	got, err := b.store.Notes.Get(note.ID)
	if err != nil {
		t.Fatalf("B get: %v", err)
	}
	if got.Title != "Salary review" || got.ContentMD != "# confidential" {
		t.Fatalf("B did not decrypt: title=%q content=%q", got.Title, got.ContentMD)
	}
}

// TestEncryptedCalendarSync proves the client-fetched calendar path is end-to-end encrypted: a
// client reconciles feed events locally and syncs; the server stores the event title as ciphertext
// (never plaintext), and a second device with the key decrypts it. This is the calendar analogue
// of TestEncryptedSyncServerStoresCiphertext, exercising the entity that used to be server-authored.
func TestEncryptedCalendarSync(t *testing.T) {
	ts, srv := newServerAPI(t)
	token := register(t, ts.URL, "cal-e2e@b.co", "password")
	cipher := crypto.NewCipher(mustKey(t))

	a := newClient(t, ts.URL, token, "devA")
	a.engine.SetCipher(cipher)
	b := newClient(t, ts.URL, token, "devB")
	b.engine.SetCipher(cipher)

	feed, err := a.store.CalendarFeeds.Create(store.CreateFeedInput{Name: "Work", URL: "https://example.com/w.ics"})
	if err != nil {
		t.Fatalf("create feed: %v", err)
	}
	start := time.Date(2026, 7, 4, 9, 0, 0, 0, time.UTC)
	loc := "HQ Room 4"
	if _, err := a.store.CalendarEvents.ReconcileFeedEvents(feed.ID, []*domain.CalendarEvent{
		{ID: "cal-ev-1", FeedID: feed.ID, ICSUID: "u1", Title: "Board meeting", StartsAt: start, Location: &loc},
	}); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if err := a.engine.Sync(); err != nil {
		t.Fatalf("A sync: %v", err)
	}

	// Server row holds ciphertext for title/location, plaintext for the schedulable starts_at.
	var storedTitle, storedStarts string
	if err := srv.queryRow(`SELECT title, starts_at FROM calendar_events WHERE id = ?;`, "cal-ev-1").Scan(&storedTitle, &storedStarts); err != nil {
		t.Fatalf("read stored event: %v", err)
	}
	if strings.Contains(storedTitle, "Board") || !crypto.IsEnvelope(storedTitle) {
		t.Fatalf("event title should be ciphertext, got %q", storedTitle)
	}
	if !strings.HasPrefix(storedStarts, "2026-07-04") {
		t.Fatalf("starts_at must stay plaintext for scheduling, got %q", storedStarts)
	}

	// Device B decrypts.
	if err := b.engine.Sync(); err != nil {
		t.Fatalf("B sync: %v", err)
	}
	got, err := b.store.CalendarEvents.GetAny("cal-ev-1")
	if err != nil {
		t.Fatalf("B get event: %v", err)
	}
	if got.Title != "Board meeting" || got.Location == nil || *got.Location != "HQ Room 4" {
		t.Fatalf("B did not decrypt event: %+v", got)
	}
}

func mustKey(t *testing.T) []byte {
	t.Helper()
	k, err := crypto.NewMasterKey()
	if err != nil {
		t.Fatal(err)
	}
	return k
}

// TestPreloginReflectsEncryptionState verifies the pre-login lookup: a plaintext (or unknown)
// account reports encrypted=false, and once key material is stored it returns the salt+params a
// client needs to derive its auth key without the server ever seeing the password.
func TestPreloginReflectsEncryptionState(t *testing.T) {
	ts := newServer(t)
	register(t, ts.URL, "pre@b.co", "password")

	var before preloginResponse
	postJSON(t, ts.URL+"/v1/auth/prelogin", map[string]string{"email": "pre@b.co"}, &before)
	if before.Encrypted {
		t.Fatal("account without keys should report encrypted=false")
	}

	// Unknown email is also encrypted=false (ambiguous, limits enumeration).
	var unknown preloginResponse
	postJSON(t, ts.URL+"/v1/auth/prelogin", map[string]string{"email": "nobody@b.co"}, &unknown)
	if unknown.Encrypted {
		t.Fatal("unknown email should report encrypted=false")
	}

	// Enable encryption, then prelogin returns the derivation params.
	tok := login(t, ts.URL, "pre@b.co", "password")
	km := keyMaterial{WrappedMasterKey: "enc$v1$AAAA", KDFSalt: "c2FsdHNhbHQ", KDFTime: 3, KDFMemoryK: 65536, KDFThreads: 4}
	authedJSON(t, http.MethodPut, ts.URL+"/v1/keys", tok, km, nil)

	var after preloginResponse
	postJSON(t, ts.URL+"/v1/auth/prelogin", map[string]string{"email": "pre@b.co"}, &after)
	if !after.Encrypted || after.Salt != km.KDFSalt || after.KDF == nil || after.KDF.Time != 3 {
		t.Fatalf("prelogin after setup = %+v", after)
	}
}

// login is a helper that logs in and returns the access token.
func login(t *testing.T, baseURL, email, pw string) string {
	t.Helper()
	var out authResponse
	if resp := postJSON(t, baseURL+"/v1/auth/login", map[string]string{"email": email, "password": pw}, &out); resp.StatusCode != http.StatusOK {
		t.Fatalf("login status = %d", resp.StatusCode)
	}
	return out.Token
}

// TestPasswordChangeRewrapEnforced verifies the server makes it impossible to change an encrypted
// account's password without rewrapping: a bare change is rejected (400), and a change carrying new
// key material atomically swaps both the credential and the wrapped key (PLAN §E2EE). A plaintext
// account still changes its password with no key material.
func TestPasswordChangeRewrapEnforced(t *testing.T) {
	ts := newServer(t)
	tok := register(t, ts.URL, "rewrap@b.co", "password")

	// Plaintext account: a normal password change (no key material) works.
	if resp := authedJSON(t, http.MethodPost, ts.URL+"/v1/account/password", tok,
		map[string]any{"currentPassword": "password", "newPassword": "password2"}, nil); resp.StatusCode != http.StatusOK {
		t.Fatalf("plaintext password change = %d, want 200", resp.StatusCode)
	}
	// Re-login after the session rotation.
	tok = login(t, ts.URL, "rewrap@b.co", "password2")

	// Enable encryption (store key material). The account is now encrypted.
	orig := keyMaterial{WrappedMasterKey: "enc$v1$OLD", KDFSalt: "c2FsdDE", KDFTime: 3, KDFMemoryK: 65536, KDFThreads: 4}
	authedJSON(t, http.MethodPut, ts.URL+"/v1/keys", tok, orig, nil)

	// A bare credential change (no rewrapped material) must now be rejected.
	if resp := authedJSON(t, http.MethodPost, ts.URL+"/v1/account/password", tok,
		map[string]any{"currentPassword": "password2", "newPassword": "authkey-new"}, nil); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("encrypted bare password change = %d, want 400", resp.StatusCode)
	}

	// A change carrying the rewrapped material swaps credential + key atomically.
	rewrapped := keyMaterial{WrappedMasterKey: "enc$v1$NEW", KDFSalt: "c2FsdDI", KDFTime: 3, KDFMemoryK: 65536, KDFThreads: 4}
	var session authResponse
	if resp := authedJSON(t, http.MethodPost, ts.URL+"/v1/account/password", tok,
		map[string]any{"currentPassword": "password2", "newPassword": "authkey-new", "keyMaterial": rewrapped}, &session); resp.StatusCode != http.StatusOK {
		t.Fatalf("encrypted rewrap change = %d, want 200", resp.StatusCode)
	}

	// The stored key material is now the rewrapped one.
	var got keyMaterial
	authedJSON(t, http.MethodGet, ts.URL+"/v1/keys", session.Token, nil, &got)
	if got.WrappedMasterKey != "enc$v1$NEW" || got.KDFSalt != "c2FsdDI" {
		t.Fatalf("key material not updated atomically: %+v", got)
	}

	// The new credential authenticates; the old one no longer does.
	if resp := postJSON(t, ts.URL+"/v1/auth/login", map[string]string{"email": "rewrap@b.co", "password": "authkey-new"}, nil); resp.StatusCode != http.StatusOK {
		t.Fatalf("login with new credential = %d, want 200", resp.StatusCode)
	}
	if resp := postJSON(t, ts.URL+"/v1/auth/login", map[string]string{"email": "rewrap@b.co", "password": "password2"}, nil); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("login with old credential = %d, want 401", resp.StatusCode)
	}
}
