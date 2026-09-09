package syncserver

import (
	"context"
	"database/sql"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// Email verification (shared by the open-core server and the cloud): the server issues a
// one-time token, emails it via the Mailer, and marks the address verified when the token
// comes back. Nothing in the open-core server gates on verification; the cloud gates
// subscribing on it (billing.handleCheckout).

const verifyTokenTTL = 24 * time.Hour

// verifyLink builds the URL the verification email points at: the custom EmailLinks when
// set (the cloud's portal), else this server's own landing page.
func (s *Server) verifyLink(token string) string {
	if s.links.Verify != nil {
		return s.links.Verify(token)
	}
	return s.publicURL + "/v1/auth/verify?token=" + token
}

// handleVerifySend issues a fresh verification token for the caller and emails the link. It
// is a no-op success when the address is already verified, so clients can call it freely.
func (s *Server) handleVerifySend(w http.ResponseWriter, r *http.Request) {
	already, err := s.SendVerification(r.Context(), userID(r))
	if err != nil {
		writeErr(w, http.StatusBadGateway, "could not send verification email")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"verified": already, "sent": !already})
}

// SendVerification issues a rotated token and emails the verification link for a user.
// Exported for wrapping binaries (the cloud admin's "resend" action). Returns
// (alreadyVerified, error): a verified address is a no-op success.
func (s *Server) SendVerification(ctx context.Context, uid string) (bool, error) {
	var email, first string
	var verifiedAt sql.NullString
	if err := s.db.QueryRowContext(ctx, s.rebind(
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
	now := s.clock.Now().UTC()
	// One live token per user: drop any prior ones so an old link can't be replayed.
	s.db.ExecContext(ctx, s.rebind(`DELETE FROM email_verification_tokens WHERE user_id = ?;`), uid)
	if _, err := s.db.ExecContext(ctx, s.rebind(
		`INSERT INTO email_verification_tokens (token, user_id, email, expires_at, created_at) VALUES (?, ?, ?, ?, ?);`),
		token, uid, email, now.Add(verifyTokenTTL).Format(timeFormat), now.Format(timeFormat)); err != nil {
		return false, err
	}

	html, err := s.mailer.Template("verify-email.html", map[string]string{
		"verifyUrl": s.verifyLink(token),
		"firstName": greetingName(first),
	})
	if err != nil {
		return false, err
	}
	if err := s.mailer.Send(email, "Confirm your Companion email", html); err != nil {
		slog.Error("verify: send email", "email", email, "err", err)
		return false, err
	}
	return false, nil
}

// sendVerificationAsync fires the post-registration verification email without holding up
// the registration response; failures are logged (the user can resend from a client).
func (s *Server) sendVerificationAsync(uid string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := s.SendVerification(ctx, uid); err != nil {
			slog.Error("verify: post-registration email", "user", uid, "err", err)
		}
	}()
}

// greetingName is the salutation for an email: the first name, or a neutral fallback.
func greetingName(first string) string {
	if first = strings.TrimSpace(first); first != "" {
		return first
	}
	return "there"
}

type verifyRequest struct {
	Token string `json:"token"`
}

// handleVerify consumes a token and marks the address verified. It is unauthenticated: the
// token itself is the proof, so the link works from any device/browser.
func (s *Server) handleVerify(w http.ResponseWriter, r *http.Request) {
	var req verifyRequest
	if err := decode(r, &req); err != nil || req.Token == "" {
		writeErr(w, http.StatusBadRequest, "token is required")
		return
	}
	switch ok, err := s.consumeVerifyToken(r.Context(), req.Token); {
	case err != nil:
		writeErr(w, http.StatusInternalServerError, "verification failed")
	case !ok:
		writeErr(w, http.StatusBadRequest, "invalid or expired link")
	default:
		writeJSON(w, http.StatusOK, map[string]any{"verified": true})
	}
}

// consumeVerifyToken spends a verification token. It returns ok=false for an unknown or
// expired token; the token is deleted regardless of outcome so it can't be retried.
func (s *Server) consumeVerifyToken(ctx context.Context, token string) (ok bool, err error) {
	var uid, email, expiresAt string
	if err := s.db.QueryRowContext(ctx, s.rebind(
		`SELECT user_id, email, expires_at FROM email_verification_tokens WHERE token = ?;`), token).
		Scan(&uid, &email, &expiresAt); err != nil {
		return false, nil
	}
	s.db.ExecContext(ctx, s.rebind(`DELETE FROM email_verification_tokens WHERE token = ?;`), token)

	exp, perr := time.Parse(timeFormat, expiresAt)
	if perr != nil || s.clock.Now().UTC().After(exp) {
		return false, nil
	}
	// Only verify if the address still matches (the user may have changed email since).
	if _, err := s.db.ExecContext(ctx, s.rebind(
		`UPDATE users SET email_verified_at = ? WHERE id = ? AND email = ?;`),
		s.clock.Now().UTC().Format(timeFormat), uid, email); err != nil {
		return false, err
	}
	return true, nil
}

// IsEmailVerified reports whether a user's address is confirmed. Exported for wrapping
// binaries that gate on it (the cloud's subscribe check).
func IsEmailVerified(ctx context.Context, db *sql.DB, dialect, uid string) bool {
	var verifiedAt sql.NullString
	err := db.QueryRowContext(ctx, rebind(dialect, `SELECT email_verified_at FROM users WHERE id = ?;`), uid).Scan(&verifiedAt)
	return err == nil && verifiedAt.Valid
}

// handleVerifyPage is the landing page the emailed link opens on a server without an
// external frontend. It does NOT consume the token on GET: mail scanners prefetch links,
// and a GET side effect would let them spend the token before the user ever clicks. The
// page confirms with a button that POSTs /v1/auth/verify.
func (s *Server) handleVerifyPage(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		renderPage(w, http.StatusBadRequest, pageData{
			Title: "Verification link problem",
			Lead:  "This verification link is missing its token. Request a new one from the Companion app.",
		})
		return
	}
	renderPage(w, http.StatusOK, pageData{
		Title:       "Confirm your email",
		Lead:        "Click below to confirm this address for your Companion account.",
		VerifyToken: token,
	})
}
