package main

import (
	"database/sql"
	"net/http"
	"os"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// passwordReset drives the forgot-password flow. The one-time token is stored on the user
// row (syncserver's users table) and rotated on every request, so only the most recent
// link works. Sending goes through the shared mailer (React Email template).
type passwordReset struct {
	db      *sql.DB
	dialect string
	mail    *mailer
	baseURL string
}

const resetTokenTTL = time.Hour

func newPasswordReset(db *sql.DB, dialect string, mail *mailer) *passwordReset {
	base := os.Getenv("CLOUD_BASE_URL")
	if base == "" {
		base = "http://localhost:8080"
	}
	return &passwordReset{db: db, dialect: dialect, mail: mail, baseURL: base}
}

func (p *passwordReset) rebind(q string) string { return rebind(p.dialect, q) }

type forgotRequest struct {
	Email string `json:"email"`
}

// handleForgot issues a rotated reset token for the address and emails the link. It always
// responds 200 regardless of whether the email exists, to avoid leaking which addresses
// are registered.
func (p *passwordReset) handleForgot(w http.ResponseWriter, r *http.Request) {
	var req forgotRequest
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	email := strings.TrimSpace(strings.ToLower(req.Email))
	ok := func() { writeJSON(w, http.StatusOK, map[string]any{"sent": true}) }

	var uid, first string
	if err := p.db.QueryRowContext(r.Context(), p.rebind(
		`SELECT id, first_name FROM users WHERE email = ?;`), email).Scan(&uid, &first); err != nil {
		ok() // Unknown address: pretend success.
		return
	}
	token, err := randomToken()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "token generation failed")
		return
	}
	now := time.Now().UTC()
	// Rotate: overwrite any prior token so only this link is valid.
	if _, err := p.db.ExecContext(r.Context(), p.rebind(
		`UPDATE users SET password_reset_token = ?, password_reset_expires_at = ? WHERE id = ?;`),
		token, now.Add(resetTokenTTL).Format(timeFormat), uid); err != nil {
		writeErr(w, http.StatusInternalServerError, "could not create token")
		return
	}
	firstName := strings.TrimSpace(first)
	if firstName == "" {
		firstName = "there"
	}
	html, err := p.mail.template("reset-password.html", map[string]string{
		"resetUrl":  p.baseURL + "/reset?token=" + token,
		"firstName": firstName,
		"baseUrl":   p.baseURL,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "template failed")
		return
	}
	// send() logs any delivery failure; respond 200 regardless so we never reveal whether
	// the address is registered (account-enumeration guard).
	_ = p.mail.send(email, "Reset your Companion Cloud password", html)
	ok()
}

// resetKeyMaterial is the master key rewrapped under the new password (PLAN §E2EE), supplied by
// the app during an encrypted-account reset. The app derives it from the recovery code; the server
// stores it verbatim (opaque ciphertext) alongside the new credential.
type resetKeyMaterial struct {
	WrappedMasterKey string `json:"wrappedMasterKey"`
	KDFSalt          string `json:"kdfSalt"`
	KDFTime          int64  `json:"kdfTime"`
	KDFMemoryK       int64  `json:"kdfMemoryK"`
	KDFThreads       int64  `json:"kdfThreads"`
	RecoveryWrapped  string `json:"recoveryWrapped,omitempty"`
}

func (m *resetKeyMaterial) valid() bool {
	return m != nil && strings.TrimSpace(m.WrappedMasterKey) != "" && strings.TrimSpace(m.KDFSalt) != "" &&
		m.KDFTime > 0 && m.KDFMemoryK > 0 && m.KDFThreads > 0
}

type resetRequest struct {
	Token       string `json:"token"`
	NewPassword string `json:"newPassword"`
	// KeyMaterial is required for an encrypted account: the reset sets the new credential and the
	// rewrapped key together, so login and decryption stay consistent (a plain reset can't, which
	// is why it's refused for encrypted accounts).
	KeyMaterial *resetKeyMaterial `json:"keyMaterial,omitempty"`
}

// resetInfoRequest / resetInfoResponse power the pre-auth lookup the app does when it opens a reset
// deep link: it learns whether the account is encrypted and, if so, gets the recovery-wrapped blob
// it needs to unwrap the master key with the user's recovery code. The reset token (emailed to the
// account owner) authorizes this lookup.
type resetInfoRequest struct {
	Token string `json:"token"`
}

type resetInfoResponse struct {
	Encrypted       bool   `json:"encrypted"`
	RecoveryWrapped string `json:"recoveryWrapped,omitempty"`
}

// handleResetInfo returns, for a valid reset token, whether the account is encrypted and its
// recovery-wrapped key blob (ciphertext, useless without the recovery code). The app uses this to
// drive the recovery flow before it can authenticate.
func (p *passwordReset) handleResetInfo(w http.ResponseWriter, r *http.Request) {
	var req resetInfoRequest
	if err := decodeJSON(r, &req); err != nil || req.Token == "" {
		writeErr(w, http.StatusBadRequest, "token is required")
		return
	}
	uid, ok := p.userForValidToken(r, req.Token)
	if !ok {
		writeErr(w, http.StatusBadRequest, "invalid or expired link")
		return
	}
	var recoveryWrapped sql.NullString
	err := p.db.QueryRowContext(r.Context(), p.rebind(
		`SELECT recovery_wrapped FROM user_keys WHERE user_id = ?;`), uid).Scan(&recoveryWrapped)
	if err == sql.ErrNoRows {
		writeJSON(w, http.StatusOK, resetInfoResponse{Encrypted: false})
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "lookup failed")
		return
	}
	writeJSON(w, http.StatusOK, resetInfoResponse{Encrypted: true, RecoveryWrapped: recoveryWrapped.String})
}

// userForValidToken returns the user id for a live (unexpired) reset token, without consuming it.
func (p *passwordReset) userForValidToken(r *http.Request, token string) (string, bool) {
	var uid, expiresAt string
	if err := p.db.QueryRowContext(r.Context(), p.rebind(
		`SELECT id, password_reset_expires_at FROM users WHERE password_reset_token = ?;`), token).
		Scan(&uid, &expiresAt); err != nil {
		return "", false
	}
	exp, err := time.Parse(timeFormat, expiresAt)
	if err != nil || time.Now().UTC().After(exp) {
		return "", false
	}
	return uid, true
}

// handleReset consumes a token and sets a new password. It clears the token and revokes
// all sessions/refresh tokens so the account is fully re-secured.
func (p *passwordReset) handleReset(w http.ResponseWriter, r *http.Request) {
	var req resetRequest
	if err := decodeJSON(r, &req); err != nil || req.Token == "" {
		writeErr(w, http.StatusBadRequest, "token is required")
		return
	}
	if len(req.NewPassword) < 6 {
		writeErr(w, http.StatusBadRequest, "new password must be at least 6 characters")
		return
	}
	var uid, expiresAt string
	err := p.db.QueryRowContext(r.Context(), p.rebind(
		`SELECT id, password_reset_expires_at FROM users WHERE password_reset_token = ?;`), req.Token).
		Scan(&uid, &expiresAt)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid or expired link")
		return
	}
	exp, perr := time.Parse(timeFormat, expiresAt)
	if perr != nil || time.Now().UTC().After(exp) {
		writeErr(w, http.StatusBadRequest, "invalid or expired link")
		return
	}
	// An end-to-end-encrypted account's password also wraps its master key, which the server can't
	// rewrap (it never holds the key). Such a reset must therefore carry the key material the app
	// rewrapped under the new password (using the recovery code); the credential and wrapped key are
	// then updated together. A plain reset (no material) on an encrypted account is refused — it
	// would orphan the key and lock the clients out (PLAN §E2EE).
	var one int
	encrypted := false
	switch kerr := p.db.QueryRowContext(r.Context(), p.rebind(
		`SELECT 1 FROM user_keys WHERE user_id = ?;`), uid).Scan(&one); kerr {
	case nil:
		encrypted = true
	case sql.ErrNoRows:
		// Plaintext account: a normal reset is safe.
	default:
		writeErr(w, http.StatusInternalServerError, "reset failed")
		return
	}
	if encrypted && !req.KeyMaterial.valid() {
		writeErr(w, http.StatusConflict,
			"This account is end-to-end encrypted. Reset it from the Companion app with your recovery code — an email reset alone can't restore your encryption key.")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), bcrypt.DefaultCost)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "hash failed")
		return
	}
	tx, err := p.db.Begin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "reset failed")
		return
	}
	defer tx.Rollback()
	// Set the new password and consume the token in one step.
	if _, err := tx.Exec(p.rebind(
		`UPDATE users SET password_hash = ?, password_reset_token = NULL, password_reset_expires_at = NULL WHERE id = ?;`),
		string(hash), uid); err != nil {
		writeErr(w, http.StatusInternalServerError, "reset failed")
		return
	}
	// For an encrypted account, store the rewrapped key material in the SAME transaction so the
	// credential and the wrapped master key can never diverge.
	if encrypted {
		m := req.KeyMaterial
		// recovery_wrapped uses COALESCE so an omitted value preserves the existing recovery blob
		// (a password reset doesn't change the recovery code) rather than nulling it out.
		if _, err := tx.Exec(p.rebind(
			`UPDATE user_keys SET wrapped_master_key = ?, kdf_salt = ?, kdf_time = ?, kdf_memory_k = ?, kdf_threads = ?, recovery_wrapped = COALESCE(?, recovery_wrapped), updated_at = ? WHERE user_id = ?;`),
			m.WrappedMasterKey, m.KDFSalt, m.KDFTime, m.KDFMemoryK, m.KDFThreads, nullIfEmptyStr(m.RecoveryWrapped), time.Now().UTC().Format(timeFormat), uid); err != nil {
			writeErr(w, http.StatusInternalServerError, "reset failed")
			return
		}
	}
	// Revoke existing sessions/refresh tokens so a leaked one can't outlive the reset.
	tx.Exec(p.rebind(`DELETE FROM sessions WHERE user_id = ?;`), uid)
	tx.Exec(p.rebind(`DELETE FROM refresh_tokens WHERE user_id = ?;`), uid)
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "reset failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"reset": true})
}

// nullIfEmptyStr maps an empty optional string to SQL NULL (for COALESCE-preserving updates).
func nullIfEmptyStr(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}
