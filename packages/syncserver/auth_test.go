package syncserver

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"
)

// postJSON posts a JSON body and decodes the response into out (when non-nil).
func postJSON(t *testing.T, url string, body any, out any) *http.Response {
	t.Helper()
	buf, _ := json.Marshal(body)
	resp, err := http.Post(url, "application/json", bytes.NewReader(buf))
	if err != nil {
		t.Fatalf("post %s: %v", url, err)
	}
	if out != nil {
		json.NewDecoder(resp.Body).Decode(out)
	}
	resp.Body.Close()
	return resp
}

// Register issues an access + refresh token; the refresh token mints a new
// access token, is single-use (rotated), and the new access token authenticates.
func TestRefreshTokenFlow(t *testing.T) {
	ts := newServer(t)
	cred := map[string]string{"email": "r@b.co", "password": "password"}

	var reg authResponse
	if resp := postJSON(t, ts.URL+"/v1/auth/register", cred, &reg); resp.StatusCode != http.StatusOK {
		t.Fatalf("register status = %d", resp.StatusCode)
	}
	if reg.Token == "" || reg.RefreshToken == "" || reg.ExpiresAt == "" {
		t.Fatalf("register response missing fields: %+v", reg)
	}

	// Exchange the refresh token for a new session.
	var refreshed authResponse
	if resp := postJSON(t, ts.URL+"/v1/auth/refresh",
		map[string]string{"refreshToken": reg.RefreshToken}, &refreshed); resp.StatusCode != http.StatusOK {
		t.Fatalf("refresh status = %d", resp.StatusCode)
	}
	if refreshed.Token == "" || refreshed.Token == reg.Token {
		t.Errorf("refresh should mint a new access token, got %q (was %q)", refreshed.Token, reg.Token)
	}
	if refreshed.RefreshToken == reg.RefreshToken {
		t.Error("refresh token should rotate")
	}

	// The old (rotated) refresh token is now dead.
	if resp := postJSON(t, ts.URL+"/v1/auth/refresh",
		map[string]string{"refreshToken": reg.RefreshToken}, nil); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("reused refresh token status = %d, want 401", resp.StatusCode)
	}

	// The refreshed access token authenticates a sync pull.
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/v1/sync/pull?cursor=0&limit=10", nil)
	req.Header.Set("Authorization", "Bearer "+refreshed.Token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("pull: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("pull with refreshed token status = %d, want 200", resp.StatusCode)
	}
}

// An unknown refresh token is rejected.
func TestRefreshTokenInvalid(t *testing.T) {
	ts := newServer(t)
	if resp := postJSON(t, ts.URL+"/v1/auth/refresh",
		map[string]string{"refreshToken": "nope"}, nil); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("invalid refresh status = %d, want 401", resp.StatusCode)
	}
}
