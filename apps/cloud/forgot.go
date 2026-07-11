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

type resetRequest struct {
	Token       string `json:"token"`
	NewPassword string `json:"newPassword"`
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
	// Revoke existing sessions/refresh tokens so a leaked one can't outlive the reset.
	tx.Exec(p.rebind(`DELETE FROM sessions WHERE user_id = ?;`), uid)
	tx.Exec(p.rebind(`DELETE FROM refresh_tokens WHERE user_id = ?;`), uid)
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "reset failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"reset": true})
}
