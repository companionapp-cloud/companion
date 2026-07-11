package syncserver

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"net/http"
	"strings"
	"time"

	"companion/core/crypto"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

const timeFormat = time.RFC3339Nano

// Access tokens are short-lived and refreshed silently by the client; the
// long-lived refresh token lets a device stay signed in across cold boots
// without re-entering credentials.
const (
	accessTokenTTL  = time.Hour
	refreshTokenTTL = 30 * 24 * time.Hour
)

type authRequest struct {
	Email     string `json:"email"`
	Password  string `json:"password"`
	FirstName string `json:"firstName"`
	LastName  string `json:"lastName"`
}

type authResponse struct {
	Token        string `json:"token"`
	RefreshToken string `json:"refreshToken"`
	ExpiresAt    string `json:"expiresAt"` // RFC3339, when Token expires
	UserID       string `json:"userId"`
}

type refreshRequest struct {
	RefreshToken string `json:"refreshToken"`
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	var req authRequest
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	email := strings.TrimSpace(strings.ToLower(req.Email))
	if email == "" || !strings.Contains(email, "@") || len(req.Password) < 6 {
		writeErr(w, http.StatusBadRequest, "a valid email and a 6+ character password are required")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "hash failed")
		return
	}
	id, _ := uuid.NewV7()
	uid := id.String()
	now := s.clock.Now().UTC().Format(timeFormat)

	if _, err := s.exec(
		`INSERT INTO users (id, email, password_hash, first_name, last_name, created_at) VALUES (?, ?, ?, ?, ?, ?);`,
		uid, email, string(hash), strings.TrimSpace(req.FirstName), strings.TrimSpace(req.LastName), now); err != nil {
		writeErr(w, http.StatusConflict, "email already registered")
		return
	}
	s.exec(`INSERT INTO user_seq (user_id, seq) VALUES (?, 0) ON CONFLICT (user_id) DO NOTHING;`, uid)

	session, err := s.newSession(uid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "session failed")
		return
	}
	writeJSON(w, http.StatusOK, session.response(uid))
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req authRequest
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	email := strings.TrimSpace(strings.ToLower(req.Email))

	var uid, hash string
	err := s.queryRow(`SELECT id, password_hash FROM users WHERE email = ?;`, email).Scan(&uid, &hash)
	if err != nil || bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
		writeErr(w, http.StatusUnauthorized, "invalid email or password")
		return
	}
	session, err := s.newSession(uid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "session failed")
		return
	}
	writeJSON(w, http.StatusOK, session.response(uid))
}

// handleRefresh exchanges a valid refresh token for a fresh access token. The
// refresh token is rotated (single-use): the presented one is deleted and a new
// one issued, so a leaked token can't be replayed after the next refresh.
func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) {
	var req refreshRequest
	if err := decode(r, &req); err != nil || req.RefreshToken == "" {
		writeErr(w, http.StatusBadRequest, "refreshToken is required")
		return
	}
	var uid, expiresAt string
	err := s.queryRow(
		`SELECT user_id, expires_at FROM refresh_tokens WHERE token = ?;`, req.RefreshToken).Scan(&uid, &expiresAt)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "invalid refresh token")
		return
	}
	// Rotate unconditionally: consume the presented token whether or not it's
	// still valid, so an expired one can't be retried.
	s.exec(`DELETE FROM refresh_tokens WHERE token = ?;`, req.RefreshToken)
	exp, perr := time.Parse(timeFormat, expiresAt)
	if perr != nil || !s.clock.Now().UTC().Before(exp) {
		writeErr(w, http.StatusUnauthorized, "refresh token expired")
		return
	}
	session, err := s.newSession(uid)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "session failed")
		return
	}
	writeJSON(w, http.StatusOK, session.response(uid))
}

type preloginRequest struct {
	Email string `json:"email"`
}

// preloginResponse tells a signing-in client how to form its credential (PLAN §E2EE). For an
// encryption-enabled account it returns the KDF salt + params so the client can derive the auth
// key locally and send that in place of the password (the server never sees the password). For a
// plaintext account — or an unknown email — it returns Encrypted=false and the client logs in with
// the raw password as before. The false case is deliberately ambiguous (unknown vs. plaintext) to
// limit account enumeration.
type preloginResponse struct {
	Encrypted bool              `json:"encrypted"`
	Salt      string            `json:"salt,omitempty"`
	KDF       *crypto.KDFParams `json:"kdf,omitempty"`
}

// handlePrelogin is the unauthenticated lookup a client performs before login to decide whether to
// send a derived auth key (encrypted account) or the raw password (plaintext account). It is
// rate-limited like the other auth endpoints to slow enumeration.
func (s *Server) handlePrelogin(w http.ResponseWriter, r *http.Request) {
	var req preloginRequest
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	email := strings.TrimSpace(strings.ToLower(req.Email))
	var salt string
	var t, m, p int64
	err := s.queryRow(
		`SELECT k.kdf_salt, k.kdf_time, k.kdf_memory_k, k.kdf_threads
		 FROM user_keys k JOIN users u ON u.id = k.user_id WHERE u.email = ?;`, email).
		Scan(&salt, &t, &m, &p)
	if err == sql.ErrNoRows {
		writeJSON(w, http.StatusOK, preloginResponse{Encrypted: false})
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "prelogin failed")
		return
	}
	writeJSON(w, http.StatusOK, preloginResponse{
		Encrypted: true,
		Salt:      salt,
		KDF:       &crypto.KDFParams{Time: uint32(t), MemoryK: uint32(m), Threads: uint8(p)},
	})
}

// session is a freshly minted access token + its rotating refresh token.
type session struct {
	token        string
	refreshToken string
	expiresAt    time.Time
}

func (s session) response(userID string) authResponse {
	return authResponse{
		Token:        s.token,
		RefreshToken: s.refreshToken,
		ExpiresAt:    s.expiresAt.Format(timeFormat),
		UserID:       userID,
	}
}

func (s *Server) newSession(userID string) (session, error) {
	now := s.clock.Now().UTC()
	access, err := randomToken()
	if err != nil {
		return session{}, err
	}
	expiresAt := now.Add(accessTokenTTL)
	if _, err := s.exec(
		`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?);`,
		access, userID, now.Format(timeFormat), expiresAt.Format(timeFormat)); err != nil {
		return session{}, err
	}
	refresh, err := randomToken()
	if err != nil {
		return session{}, err
	}
	if _, err := s.exec(
		`INSERT INTO refresh_tokens (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?);`,
		refresh, userID, now.Format(timeFormat), now.Add(refreshTokenTTL).Format(timeFormat)); err != nil {
		return session{}, err
	}
	return session{token: access, refreshToken: refresh, expiresAt: expiresAt}, nil
}

func randomToken() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
