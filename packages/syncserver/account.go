package syncserver

import (
	"database/sql"
	"net/http"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

// Account self-service (profile + credentials) lives in the shared library so both the
// open-core server and the cloud expose the exact same endpoints (PLAN §10). They sit
// under /v1/account and require a valid session (the cloud mounts them at /api/v1/account
// like the rest of the API).

type accountResponse struct {
	UserID        string `json:"userId"`
	Email         string `json:"email"`
	FirstName     string `json:"firstName"`
	LastName      string `json:"lastName"`
	EmailVerified bool   `json:"emailVerified"`
}

// handleAccount returns the authenticated user's profile.
func (s *Server) handleAccount(w http.ResponseWriter, r *http.Request) {
	uid := userID(r)
	var email, first, last string
	var verifiedAt sql.NullString
	err := s.queryRow(
		`SELECT email, first_name, last_name, email_verified_at FROM users WHERE id = ?;`, uid).
		Scan(&email, &first, &last, &verifiedAt)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "account lookup failed")
		return
	}
	writeJSON(w, http.StatusOK, accountResponse{
		UserID: uid, Email: email, FirstName: first, LastName: last,
		EmailVerified: verifiedAt.Valid,
	})
}

type profileRequest struct {
	FirstName string `json:"firstName"`
	LastName  string `json:"lastName"`
}

// handleUpdateProfile sets the user's first/last name.
func (s *Server) handleUpdateProfile(w http.ResponseWriter, r *http.Request) {
	uid := userID(r)
	var req profileRequest
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	if _, err := s.exec(
		`UPDATE users SET first_name = ?, last_name = ? WHERE id = ?;`,
		strings.TrimSpace(req.FirstName), strings.TrimSpace(req.LastName), uid); err != nil {
		writeErr(w, http.StatusInternalServerError, "update failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"firstName": strings.TrimSpace(req.FirstName),
		"lastName":  strings.TrimSpace(req.LastName),
	})
}

type emailRequest struct {
	Email string `json:"email"`
}

// handleUpdateEmail changes the account email. It re-applies the same validation as
// registration and relies on the UNIQUE constraint to reject an address already in use.
func (s *Server) handleUpdateEmail(w http.ResponseWriter, r *http.Request) {
	uid := userID(r)
	var req emailRequest
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	email := strings.TrimSpace(strings.ToLower(req.Email))
	if email == "" || !strings.Contains(email, "@") {
		writeErr(w, http.StatusBadRequest, "a valid email is required")
		return
	}
	// Changing the address drops its verified status: ownership of the new address hasn't
	// been proven, and downstream gates (e.g. the cloud's subscribe-requires-verified check)
	// must not inherit the old address's trust.
	if _, err := s.exec(`UPDATE users SET email = ?, email_verified_at = NULL WHERE id = ?;`, email, uid); err != nil {
		writeErr(w, http.StatusConflict, "email already registered")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"email": email})
}

type passwordRequest struct {
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
}

// handleUpdatePassword changes the account password after verifying the current one, then
// revokes every other session so a stale/leaked token can't outlive the change.
func (s *Server) handleUpdatePassword(w http.ResponseWriter, r *http.Request) {
	uid := userID(r)
	var req passwordRequest
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	if len(req.NewPassword) < 6 {
		writeErr(w, http.StatusBadRequest, "new password must be at least 6 characters")
		return
	}
	var hash string
	if err := s.queryRow(`SELECT password_hash FROM users WHERE id = ?;`, uid).Scan(&hash); err != nil {
		writeErr(w, http.StatusInternalServerError, "account lookup failed")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.CurrentPassword)) != nil {
		writeErr(w, http.StatusUnauthorized, "current password is incorrect")
		return
	}
	newHash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), bcrypt.DefaultCost)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "hash failed")
		return
	}
	tx, err := s.db.Begin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "update failed")
		return
	}
	defer tx.Rollback()
	if _, err := tx.Exec(s.rebind(`UPDATE users SET password_hash = ? WHERE id = ?;`), string(newHash), uid); err != nil {
		writeErr(w, http.StatusInternalServerError, "update failed")
		return
	}
	// Invalidate all sessions and refresh tokens; the client re-authenticates with the new
	// password. A brand-new session is minted below so the current device stays signed in.
	if _, err := tx.Exec(s.rebind(`DELETE FROM sessions WHERE user_id = ?;`), uid); err != nil {
		writeErr(w, http.StatusInternalServerError, "update failed")
		return
	}
	if _, err := tx.Exec(s.rebind(`DELETE FROM refresh_tokens WHERE user_id = ?;`), uid); err != nil {
		writeErr(w, http.StatusInternalServerError, "update failed")
		return
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "update failed")
		return
	}
	// Mint a fresh session so the caller isn't logged out by its own password change.
	session, err := s.newSession(uid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "session failed")
		return
	}
	writeJSON(w, http.StatusOK, session.response(uid))
}
