package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"time"

	"companion/core/domain"
)

// Server is the sync + auth API over a SQL store (Postgres or SQLite). Single-user
// auth ships now; the schema and endpoints are multi-tenant-ready (PLAN §10).
type Server struct {
	db      *sql.DB
	dialect string
	clock   domain.Clock
	hub     *Hub
}

func NewServer(db *sql.DB, dialect string) *Server {
	return &Server{db: db, dialect: dialect, clock: domain.SystemClock{}, hub: NewHub()}
}

// rebind adapts '?' placeholders to the active dialect ('$N' on Postgres).
func (s *Server) rebind(q string) string { return rebind(s.dialect, q) }

func (s *Server) exec(q string, args ...any) (sql.Result, error) {
	return s.db.Exec(s.rebind(q), args...)
}
func (s *Server) query(q string, args ...any) (*sql.Rows, error) {
	return s.db.Query(s.rebind(q), args...)
}
func (s *Server) queryRow(q string, args ...any) *sql.Row { return s.db.QueryRow(s.rebind(q), args...) }

// Handler wires the routes (Go 1.22+ method-aware ServeMux), wrapped in permissive
// dev CORS so the browser (web app) can sync cross-origin.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/auth/register", s.handleRegister)
	mux.HandleFunc("POST /v1/auth/login", s.handleLogin)
	mux.HandleFunc("POST /v1/auth/refresh", s.handleRefresh)
	mux.Handle("GET /v1/sync/pull", s.authed(s.handlePull))
	mux.Handle("POST /v1/sync/push", s.authed(s.handlePush))
	mux.Handle("GET /v1/sync/events", s.authed(s.handleEvents))
	return withCORS(mux)
}

// withCORS allows any origin with a bearer token (no cookies), and short-circuits
// preflight requests. Dev-only breadth; tighten for production.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		h.Set("Access-Control-Max-Age", "600")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type ctxKey int

const userIDKey ctxKey = 0

func userID(r *http.Request) string {
	v, _ := r.Context().Value(userIDKey).(string)
	return v
}

// authed requires a valid bearer token and injects the user id.
func (s *Server) authed(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := bearer(r)
		if token == "" {
			writeErr(w, http.StatusUnauthorized, "missing bearer token")
			return
		}
		var uid string
		var expiresAt sql.NullString
		err := s.queryRow(`SELECT user_id, expires_at FROM sessions WHERE token = ?;`, token).Scan(&uid, &expiresAt)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "invalid token")
			return
		}
		// Timestamps are RFC3339Nano text (variable-width fractional seconds), so
		// compare as parsed times rather than lexically. A NULL expiry marks a
		// legacy session minted before expiry existed — treat it as non-expiring.
		if expiresAt.Valid {
			exp, perr := time.Parse(timeFormat, expiresAt.String)
			if perr != nil || !s.clock.Now().UTC().Before(exp) {
				writeErr(w, http.StatusUnauthorized, "token expired")
				return
			}
		}
		next(w, r.WithContext(context.WithValue(r.Context(), userIDKey, uid)))
	})
}

func bearer(r *http.Request) string {
	const prefix = "Bearer "
	h := r.Header.Get("Authorization")
	if len(h) > len(prefix) && h[:len(prefix)] == prefix {
		return h[len(prefix):]
	}
	return ""
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func decode(r *http.Request, v any) error {
	return json.NewDecoder(r.Body).Decode(v)
}
