package syncserver

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// newTestReset builds a Server over an in-memory DB for driving the reset handlers directly.
func newTestReset(t *testing.T) *Server {
	t.Helper()
	db, dialect, err := OpenDB(":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return New(db, dialect, WithPublicURL("https://sync.example.test/"))
}

// seedResettableUser inserts a user with a live reset token; encrypted also adds a user_keys row.
func seedResettableUser(t *testing.T, s *Server, uid, email, token string, encrypted bool) {
	t.Helper()
	now := time.Now().UTC()
	if _, err := s.exec(
		`INSERT INTO users (id, email, password_hash, created_at, password_reset_token, password_reset_expires_at)
		 VALUES (?, ?, ?, ?, ?, ?);`,
		uid, email, "oldhash", now.Format(timeFormat), token, now.Add(time.Hour).Format(timeFormat)); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if encrypted {
		if _, err := s.exec(
			`INSERT INTO user_keys (user_id, wrapped_master_key, kdf_salt, kdf_time, kdf_memory_k, kdf_threads, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?);`,
			uid, "enc$v1$X", "c2FsdA", 3, 65536, 4, now.Format(timeFormat)); err != nil {
			t.Fatalf("seed keys: %v", err)
		}
	}
}

func postReset(t *testing.T, s *Server, token, newPassword string) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"token": token, "newPassword": newPassword})
	req := httptest.NewRequest(http.MethodPost, "/v1/auth/reset", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	s.handleReset(rec, req)
	return rec
}

// TestResetRefusedForEncryptedAccount: an email password reset on an encrypted account is
// refused (the server can't rewrap the master key), so it can never desync the login credential
// from the wrapped key and lock the clients out. A plaintext account still resets.
func TestResetRefusedForEncryptedAccount(t *testing.T) {
	s := newTestReset(t)

	// Plaintext account: reset succeeds.
	seedResettableUser(t, s, "u-plain", "plain@b.co", "tok-plain", false)
	if rec := postReset(t, s, "tok-plain", "newpassword"); rec.Code != http.StatusOK {
		t.Fatalf("plaintext reset = %d, want 200", rec.Code)
	}

	// Encrypted account: reset is refused, and the credential is left untouched.
	seedResettableUser(t, s, "u-enc", "enc@b.co", "tok-enc", true)
	rec := postReset(t, s, "tok-enc", "newpassword")
	if rec.Code != http.StatusConflict {
		t.Fatalf("encrypted reset = %d, want 409", rec.Code)
	}
	var stillOld string
	s.queryRow(`SELECT password_hash FROM users WHERE id = ?;`, "u-enc").Scan(&stillOld)
	if stillOld != "oldhash" {
		t.Fatalf("encrypted account credential must be unchanged, got %q", stillOld)
	}
}

// postResetInfo hits the pre-auth reset/info lookup.
func postResetInfo(t *testing.T, s *Server, token string) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"token": token})
	req := httptest.NewRequest(http.MethodPost, "/v1/auth/reset/info", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	s.handleResetInfo(rec, req)
	return rec
}

// postResetWithMaterial resets an encrypted account with rewrapped key material.
func postResetWithMaterial(t *testing.T, s *Server, token, newPassword string, km map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"token": token, "newPassword": newPassword, "keyMaterial": km})
	req := httptest.NewRequest(http.MethodPost, "/v1/auth/reset", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	s.handleReset(rec, req)
	return rec
}

// TestResetInfoAndEncryptedReset covers the recovery-reset path: reset/info reports the account is
// encrypted and returns its recovery blob, and a reset carrying rewrapped material succeeds and
// atomically updates both the credential and the wrapped key.
func TestResetInfoAndEncryptedReset(t *testing.T) {
	s := newTestReset(t)
	seedResettableUser(t, s, "u-enc", "enc@b.co", "tok-enc", true)
	// Give it a recovery blob so reset/info returns it.
	s.exec(`UPDATE user_keys SET recovery_wrapped = ? WHERE user_id = ?;`, "enc$v1$REC", "u-enc")

	// reset/info reports encrypted + the recovery blob.
	var info resetInfoResponse
	rec := postResetInfo(t, s, "tok-enc")
	if rec.Code != http.StatusOK {
		t.Fatalf("reset/info = %d, want 200", rec.Code)
	}
	json.Unmarshal(rec.Body.Bytes(), &info)
	if !info.Encrypted || info.RecoveryWrapped != "enc$v1$REC" {
		t.Fatalf("reset/info = %+v", info)
	}

	// A reset WITHOUT material is still refused (409).
	if r := postReset(t, s, "tok-enc", "authkey-new"); r.Code != http.StatusConflict {
		t.Fatalf("encrypted reset w/o material = %d, want 409", r.Code)
	}

	// A reset WITH rewrapped material succeeds and updates both credential and wrapped key.
	km := map[string]any{"wrappedMasterKey": "enc$v1$NEWWRAP", "kdfSalt": "c2FsdA", "kdfTime": 3, "kdfMemoryK": 65536, "kdfThreads": 4}
	if r := postResetWithMaterial(t, s, "tok-enc", "authkey-new", km); r.Code != http.StatusOK {
		t.Fatalf("encrypted reset w/ material = %d, want 200 (body: %s)", r.Code, r.Body.String())
	}
	var wrapped, recovery string
	s.queryRow(`SELECT wrapped_master_key, recovery_wrapped FROM user_keys WHERE user_id = ?;`, "u-enc").Scan(&wrapped, &recovery)
	if wrapped != "enc$v1$NEWWRAP" {
		t.Fatalf("wrapped key not updated: %q", wrapped)
	}
	if recovery != "enc$v1$REC" {
		t.Fatalf("recovery blob should be preserved (COALESCE), got %q", recovery)
	}
	// Token consumed: a second use fails.
	if r := postResetWithMaterial(t, s, "tok-enc", "x", km); r.Code == http.StatusOK {
		t.Fatalf("reused reset token should fail")
	}
}

// TestForgotIssuesTokenOverHTTP drives the full open-core route: a forgot request for a known
// address stores a live reset token (and answers 200 either way, so addresses can't be
// enumerated), and the emailed landing page hands off to the app with token + server.
func TestForgotIssuesTokenOverHTTP(t *testing.T) {
	ts, srv := newServerAPI(t)
	srv.publicURL = "https://sync.example.test"

	var reg authResponse
	if resp := postJSON(t, ts.URL+"/v1/auth/register",
		map[string]string{"email": "who@b.co", "password": "password"}, &reg); resp.StatusCode != http.StatusOK {
		t.Fatalf("register status = %d", resp.StatusCode)
	}

	var out map[string]any
	if resp := postJSON(t, ts.URL+"/v1/auth/forgot", map[string]string{"email": "nobody@b.co"}, &out); resp.StatusCode != http.StatusOK {
		t.Fatalf("forgot (unknown) status = %d, want 200", resp.StatusCode)
	}
	if resp := postJSON(t, ts.URL+"/v1/auth/forgot", map[string]string{"email": "WHO@b.co"}, &out); resp.StatusCode != http.StatusOK {
		t.Fatalf("forgot (known) status = %d, want 200", resp.StatusCode)
	}
	var token string
	if err := srv.queryRow(`SELECT password_reset_token FROM users WHERE id = ?;`, reg.UserID).Scan(&token); err != nil || token == "" {
		t.Fatalf("reset token not stored: %q err=%v", token, err)
	}

	// The landing page carries the app deep link with the token and this server's public URL.
	resp, err := http.Get(ts.URL + "/v1/auth/reset?token=" + token)
	if err != nil {
		t.Fatalf("reset page: %v", err)
	}
	defer resp.Body.Close()
	var body bytes.Buffer
	body.ReadFrom(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("reset page status = %d: %s", resp.StatusCode, body.String())
	}
	want := "companion://reset?resetToken=" + token + "&amp;server=https%3A%2F%2Fsync.example.test"
	if !strings.Contains(body.String(), want) {
		t.Fatalf("reset page missing app link %q:\n%s", want, body.String())
	}

	// An unknown token gets the expired page, not a hand-off.
	if resp, err := http.Get(ts.URL + "/v1/auth/reset?token=bogus"); err != nil || resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("bogus reset page: status=%v err=%v", resp.StatusCode, err)
	}
}
