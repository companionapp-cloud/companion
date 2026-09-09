package syncserver

import (
	"bytes"
	"database/sql"
	"net/http"
	"strings"
	"testing"
)

// TestVerifyEmailFlow drives the shared verification route end to end: send issues a token
// for the signed-in user, the landing page never consumes it on GET (link prefetchers), and
// POSTing the token marks the address verified exactly once.
func TestVerifyEmailFlow(t *testing.T) {
	ts, srv := newServerAPI(t)

	var reg authResponse
	if resp := postJSON(t, ts.URL+"/v1/auth/register",
		map[string]string{"email": "v@b.co", "password": "password", "firstName": "Vee"}, &reg); resp.StatusCode != http.StatusOK {
		t.Fatalf("register status = %d", resp.StatusCode)
	}

	// Sending requires a session.
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/auth/verify/send", mustJSON(map[string]string{}))
	req.Header.Set("Authorization", "Bearer "+reg.Token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("send status = %d, want 200", resp.StatusCode)
	}
	var token string
	if err := srv.queryRow(`SELECT token FROM email_verification_tokens WHERE user_id = ?;`, reg.UserID).Scan(&token); err != nil {
		t.Fatalf("token not issued: %v", err)
	}

	// GET renders a confirm page and leaves the token unspent.
	page, err := http.Get(ts.URL + "/v1/auth/verify?token=" + token)
	if err != nil {
		t.Fatalf("verify page: %v", err)
	}
	var body bytes.Buffer
	body.ReadFrom(page.Body)
	page.Body.Close()
	if page.StatusCode != http.StatusOK || !strings.Contains(body.String(), "Confirm email") {
		t.Fatalf("verify page status = %d body:\n%s", page.StatusCode, body.String())
	}
	var verifiedAt sql.NullString
	srv.queryRow(`SELECT email_verified_at FROM users WHERE id = ?;`, reg.UserID).Scan(&verifiedAt)
	if verifiedAt.Valid {
		t.Fatalf("GET must not verify (prefetch safety)")
	}

	// POST consumes it.
	var out map[string]any
	if resp := postJSON(t, ts.URL+"/v1/auth/verify", map[string]string{"token": token}, &out); resp.StatusCode != http.StatusOK {
		t.Fatalf("verify status = %d, want 200", resp.StatusCode)
	}
	srv.queryRow(`SELECT email_verified_at FROM users WHERE id = ?;`, reg.UserID).Scan(&verifiedAt)
	if !verifiedAt.Valid {
		t.Fatalf("email_verified_at not set after verify")
	}
	// Replay fails: the token was spent.
	if resp := postJSON(t, ts.URL+"/v1/auth/verify", map[string]string{"token": token}, &out); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("replayed verify status = %d, want 400", resp.StatusCode)
	}
	// Already verified: send is a no-op success.
	req, _ = http.NewRequest(http.MethodPost, ts.URL+"/v1/auth/verify/send", mustJSON(map[string]string{}))
	req.Header.Set("Authorization", "Bearer "+reg.Token)
	if resp, err := http.DefaultClient.Do(req); err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("resend after verified: status=%v err=%v", resp.StatusCode, err)
	}
}
