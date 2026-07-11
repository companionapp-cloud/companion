package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"companion/syncserver"
)

// verifier drives email confirmation: it issues one-time tokens, emails them via the
// mailer (React Email template), and marks the address verified. The cloud gates
// subscribing on verification (see billing.handleCheckout).
type verifier struct {
	db      *sql.DB
	dialect string
	mail    *mailer
	baseURL string // CLOUD_BASE_URL, used to build the verification link
}

const verifyTokenTTL = 24 * time.Hour

func newVerifier(db *sql.DB, dialect string, mail *mailer) *verifier {
	base := os.Getenv("CLOUD_BASE_URL")
	if base == "" {
		base = "http://localhost:8080"
	}
	return &verifier{db: db, dialect: dialect, mail: mail, baseURL: base}
}

func (v *verifier) rebind(q string) string { return rebind(v.dialect, q) }

// handleSend issues a fresh verification token for the caller and emails the link. It is a
// no-op success when the address is already verified, so the frontend can call it freely.
func (v *verifier) handleSend(w http.ResponseWriter, r *http.Request) {
	already, err := v.sendVerification(r.Context(), syncserver.UserID(r))
	if err != nil {
		writeErr(w, http.StatusBadGateway, "could not send verification email")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"verified": already, "sent": !already})
}

// sendVerification issues a rotated token and emails the verification link for a user.
// Reused by the self-serve endpoint and the admin "resend" action. Returns
// (alreadyVerified, error): a verified address is a no-op success.
func (v *verifier) sendVerification(ctx context.Context, uid string) (bool, error) {
	var email, first string
	var verifiedAt sql.NullString
	if err := v.db.QueryRowContext(ctx, v.rebind(
		`SELECT email, first_name, email_verified_at FROM users WHERE id = ?;`), uid).
		Scan(&email, &first, &verifiedAt); err != nil {
		return false, err
	}
	if verifiedAt.Valid {
		return true, nil
	}

	token, err := randomToken()
	if err != nil {
		return false, err
	}
	now := time.Now().UTC()
	// One live token per user: drop any prior ones so an old link can't be replayed.
	v.db.ExecContext(ctx, v.rebind(`DELETE FROM email_verification_tokens WHERE user_id = ?;`), uid)
	if _, err := v.db.ExecContext(ctx, v.rebind(
		`INSERT INTO email_verification_tokens (token, user_id, email, expires_at, created_at) VALUES (?, ?, ?, ?, ?);`),
		token, uid, email, now.Add(verifyTokenTTL).Format(timeFormat), now.Format(timeFormat)); err != nil {
		return false, err
	}

	firstName := strings.TrimSpace(first)
	if firstName == "" {
		firstName = "there"
	}
	html, err := v.mail.template("verify-email.html", map[string]string{
		"verifyUrl": v.baseURL + "/verify?token=" + token,
		"firstName": firstName,
		"baseUrl":   v.baseURL,
	})
	if err != nil {
		return false, err
	}
	if err := v.mail.send(email, "Confirm your Companion Cloud email", html); err != nil {
		slog.Error("verify: send email", "email", email, "err", err)
		return false, err
	}
	return false, nil
}

type verifyRequest struct {
	Token string `json:"token"`
}

// handleVerify consumes a token and marks the address verified. It is unauthenticated: the
// token itself is the proof, so the link works from any device/browser.
func (v *verifier) handleVerify(w http.ResponseWriter, r *http.Request) {
	var req verifyRequest
	if err := decodeJSON(r, &req); err != nil || req.Token == "" {
		writeErr(w, http.StatusBadRequest, "token is required")
		return
	}
	var uid, email, expiresAt string
	err := v.db.QueryRowContext(r.Context(), v.rebind(
		`SELECT user_id, email, expires_at FROM email_verification_tokens WHERE token = ?;`), req.Token).
		Scan(&uid, &email, &expiresAt)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid or expired link")
		return
	}
	// Consume the token regardless of outcome so it can't be retried.
	v.db.ExecContext(r.Context(), v.rebind(`DELETE FROM email_verification_tokens WHERE token = ?;`), req.Token)

	exp, perr := time.Parse(timeFormat, expiresAt)
	if perr != nil || time.Now().UTC().After(exp) {
		writeErr(w, http.StatusBadRequest, "invalid or expired link")
		return
	}
	// Only verify if the address still matches (the user may have changed email since).
	if _, err := v.db.ExecContext(r.Context(), v.rebind(
		`UPDATE users SET email_verified_at = ? WHERE id = ? AND email = ?;`),
		time.Now().UTC().Format(timeFormat), uid, email); err != nil {
		writeErr(w, http.StatusInternalServerError, "verification failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"verified": true})
}

// isEmailVerified reports whether a user's address is confirmed.
func isEmailVerified(ctx context.Context, db *sql.DB, dialect, uid string) bool {
	var verifiedAt sql.NullString
	err := db.QueryRowContext(ctx, rebind(dialect, `SELECT email_verified_at FROM users WHERE id = ?;`), uid).Scan(&verifiedAt)
	return err == nil && verifiedAt.Valid
}

func randomToken() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
