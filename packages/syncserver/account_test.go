package syncserver

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

func mustJSON(v any) io.Reader {
	buf, _ := json.Marshal(v)
	return bytes.NewReader(buf)
}

// Changing the account email must drop email_verified_at: the new address hasn't been
// proven, so downstream gates (e.g. the cloud's subscribe check) mustn't inherit the old
// address's verified status.
func TestUpdateEmailClearsVerification(t *testing.T) {
	ts, srv := newServerAPI(t)

	var reg authResponse
	if resp := postJSON(t, ts.URL+"/v1/auth/register",
		map[string]string{"email": "old@b.co", "password": "password"}, &reg); resp.StatusCode != http.StatusOK {
		t.Fatalf("register status = %d", resp.StatusCode)
	}

	// Mark the current address verified out of band.
	if _, err := srv.exec(`UPDATE users SET email_verified_at = ? WHERE id = ?;`,
		srv.clock.Now().UTC().Format(timeFormat), reg.UserID); err != nil {
		t.Fatalf("seed verified: %v", err)
	}

	// Change the address.
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/account/email", mustJSON(map[string]string{"email": "new@b.co"}))
	req.Header.Set("Authorization", "Bearer "+reg.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("update email: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("update email status = %d, want 200", resp.StatusCode)
	}

	var verifiedAt sql.NullString
	if err := srv.queryRow(`SELECT email_verified_at FROM users WHERE id = ?;`, reg.UserID).Scan(&verifiedAt); err != nil {
		t.Fatalf("read verified: %v", err)
	}
	if verifiedAt.Valid {
		t.Errorf("email_verified_at should be NULL after an email change, got %q", verifiedAt.String)
	}
}

// Registration rejects a syntactically invalid email.
func TestRegisterRejectsInvalidEmail(t *testing.T) {
	ts := newServer(t)
	if resp := postJSON(t, ts.URL+"/v1/auth/register",
		map[string]string{"email": "not-an-email", "password": "password"}, nil); resp.StatusCode != http.StatusBadRequest {
		t.Errorf("register with invalid email status = %d, want 400", resp.StatusCode)
	}
}
