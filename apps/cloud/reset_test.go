package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"companion/syncserver"
)

// newTestReset builds a passwordReset over an in-memory DB with the cloud schema applied.
func newTestReset(t *testing.T) *passwordReset {
	t.Helper()
	db, dialect, err := syncserver.OpenDB(":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if err := applyCloudSchema(db, dialect); err != nil {
		t.Fatalf("schema: %v", err)
	}
	return &passwordReset{db: db, dialect: dialect}
}

// seedResettableUser inserts a user with a live reset token; encrypted also adds a user_keys row.
func seedResettableUser(t *testing.T, p *passwordReset, uid, email, token string, encrypted bool) {
	t.Helper()
	now := time.Now().UTC()
	if _, err := p.db.Exec(p.rebind(
		`INSERT INTO users (id, email, password_hash, created_at, password_reset_token, password_reset_expires_at)
		 VALUES (?, ?, ?, ?, ?, ?);`),
		uid, email, "oldhash", now.Format(timeFormat), token, now.Add(time.Hour).Format(timeFormat)); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if encrypted {
		if _, err := p.db.Exec(p.rebind(
			`INSERT INTO user_keys (user_id, wrapped_master_key, kdf_salt, kdf_time, kdf_memory_k, kdf_threads, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?);`),
			uid, "enc$v1$X", "c2FsdA", 3, 65536, 4, now.Format(timeFormat)); err != nil {
			t.Fatalf("seed keys: %v", err)
		}
	}
}

func postReset(t *testing.T, p *passwordReset, token, newPassword string) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"token": token, "newPassword": newPassword})
	req := httptest.NewRequest(http.MethodPost, "/reset", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	p.handleReset(rec, req)
	return rec
}

// TestResetRefusedForEncryptedAccount is the bug fix: an email password reset on an encrypted
// account is refused (the server can't rewrap the master key), so it can never desync the login
// credential from the wrapped key and lock the clients out. A plaintext account still resets.
func TestResetRefusedForEncryptedAccount(t *testing.T) {
	p := newTestReset(t)

	// Plaintext account: reset succeeds.
	seedResettableUser(t, p, "u-plain", "plain@b.co", "tok-plain", false)
	if rec := postReset(t, p, "tok-plain", "newpassword"); rec.Code != http.StatusOK {
		t.Fatalf("plaintext reset = %d, want 200", rec.Code)
	}

	// Encrypted account: reset is refused, and the credential is left untouched.
	seedResettableUser(t, p, "u-enc", "enc@b.co", "tok-enc", true)
	rec := postReset(t, p, "tok-enc", "newpassword")
	if rec.Code != http.StatusConflict {
		t.Fatalf("encrypted reset = %d, want 409", rec.Code)
	}
	var stillOld string
	p.db.QueryRow(p.rebind(`SELECT password_hash FROM users WHERE id = ?;`), "u-enc").Scan(&stillOld)
	if stillOld != "oldhash" {
		t.Fatalf("encrypted account credential must be unchanged, got %q", stillOld)
	}
}

// postResetInfo hits the pre-auth reset/info lookup.
func postResetInfo(t *testing.T, p *passwordReset, token string) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"token": token})
	req := httptest.NewRequest(http.MethodPost, "/reset/info", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	p.handleResetInfo(rec, req)
	return rec
}

// postResetWithMaterial resets an encrypted account with rewrapped key material.
func postResetWithMaterial(t *testing.T, p *passwordReset, token, newPassword string, km map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"token": token, "newPassword": newPassword, "keyMaterial": km})
	req := httptest.NewRequest(http.MethodPost, "/reset", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	p.handleReset(rec, req)
	return rec
}

// TestResetInfoAndEncryptedReset covers the recovery-reset path: reset/info reports the account is
// encrypted and returns its recovery blob, and a reset carrying rewrapped material succeeds and
// atomically updates both the credential and the wrapped key.
func TestResetInfoAndEncryptedReset(t *testing.T) {
	p := newTestReset(t)
	seedResettableUser(t, p, "u-enc", "enc@b.co", "tok-enc", true) // seeds user_keys w/ recovery_wrapped "" ... set one below
	// Give it a recovery blob so reset/info returns it.
	p.db.Exec(p.rebind(`UPDATE user_keys SET recovery_wrapped = ? WHERE user_id = ?;`), "enc$v1$REC", "u-enc")

	// reset/info reports encrypted + the recovery blob.
	var info resetInfoResponse
	rec := postResetInfo(t, p, "tok-enc")
	if rec.Code != http.StatusOK {
		t.Fatalf("reset/info = %d, want 200", rec.Code)
	}
	json.Unmarshal(rec.Body.Bytes(), &info)
	if !info.Encrypted || info.RecoveryWrapped != "enc$v1$REC" {
		t.Fatalf("reset/info = %+v", info)
	}

	// A reset WITHOUT material is still refused (409).
	if r := postReset(t, p, "tok-enc", "authkey-new"); r.Code != http.StatusConflict {
		t.Fatalf("encrypted reset w/o material = %d, want 409", r.Code)
	}

	// A reset WITH rewrapped material succeeds and updates both credential and wrapped key.
	km := map[string]any{"wrappedMasterKey": "enc$v1$NEWWRAP", "kdfSalt": "c2FsdA", "kdfTime": 3, "kdfMemoryK": 65536, "kdfThreads": 4}
	if r := postResetWithMaterial(t, p, "tok-enc", "authkey-new", km); r.Code != http.StatusOK {
		t.Fatalf("encrypted reset w/ material = %d, want 200 (body: %s)", r.Code, r.Body.String())
	}
	var wrapped, recovery string
	p.db.QueryRow(p.rebind(`SELECT wrapped_master_key, recovery_wrapped FROM user_keys WHERE user_id = ?;`), "u-enc").Scan(&wrapped, &recovery)
	if wrapped != "enc$v1$NEWWRAP" {
		t.Fatalf("wrapped key not updated: %q", wrapped)
	}
	if recovery != "enc$v1$REC" {
		t.Fatalf("recovery blob should be preserved (COALESCE), got %q", recovery)
	}
	// Token consumed: a second use fails.
	if r := postResetWithMaterial(t, p, "tok-enc", "x", km); r.Code == http.StatusOK {
		t.Fatalf("reused reset token should fail")
	}
}
