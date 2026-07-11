package syncserver

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"companion/core/domain"
)

// Server is the sync + auth API over a SQL store (Postgres or SQLite). Single-user
// auth ships now; the schema and endpoints are multi-tenant-ready (PLAN §10).
type Server struct {
	db       *sql.DB
	dialect  string
	clock    domain.Clock
	hub      *Hub
	entities map[string]*entityHandler // per-entity sync SQL, lazily built
	// blobs stores document bytes in object storage (PLAN §6.9); maxBlobSize caps an
	// upload. Selected from the environment (S3 / filesystem / in-memory).
	blobs       BlobBackend
	maxBlobSize int64
	// syncGuard, when set, authorizes every sync-gated request (pull/push/events/blobs/
	// calendar) before it runs. The open-core server leaves it nil (always allow); the
	// cloud injects a subscription check that returns an error → 403. Auth endpoints are
	// never guarded, so users can register/login before they are authorized to sync.
	syncGuard func(ctx context.Context, userID string) error
	// corsMW wraps the mux with cross-origin headers. When nil, Handler defaults to
	// allow-all (dev convenience for the open-core server). The cloud sets its own
	// env-configured policy via WithCORS, or WithoutCORS to own CORS at a higher layer.
	corsMW func(http.Handler) http.Handler
	// authLimiter rate-limits the unauthenticated credential endpoints (register/login/
	// refresh) per client IP, so password stuffing and account-creation floods are bounded.
	authLimiter *RateLimiter
}

// Per-IP, per-endpoint limits for the credential routes: enough headroom for a human
// retrying, restrictive for automated abuse.
const (
	authRatePerMinute = 20
	authBurst         = 10
)

// Option customizes a Server at construction. The open-core binary passes none; the
// cloud wraps billing/subscription authorization via WithSyncGuard.
type Option func(*Server)

// WithSyncGuard authorizes each sync-gated request. fn receives the request's user id;
// a non-nil error rejects the request with 403 and the error's message.
func WithSyncGuard(fn func(ctx context.Context, userID string) error) Option {
	return func(s *Server) { s.syncGuard = fn }
}

// WithCORS sets the allowed cross-origin origins for Handler. A single "*" allows any
// origin; otherwise only listed origins are echoed back (with Vary: Origin).
func WithCORS(origins ...string) Option {
	return func(s *Server) { s.corsMW = CORS(origins) }
}

// WithoutCORS disables Handler's built-in CORS wrapping, for when a wrapping binary (the
// cloud) applies a single CORS policy across its whole routing tree instead.
func WithoutCORS() Option {
	return func(s *Server) { s.corsMW = func(next http.Handler) http.Handler { return next } }
}

// New builds a Server over a SQL store (Postgres or SQLite). Options layer optional
// behavior (e.g. WithSyncGuard) without changing the open-core defaults.
func New(db *sql.DB, dialect string, opts ...Option) *Server {
	backend, err := newBlobBackend()
	if err != nil {
		// Only reached when an S3 backend is explicitly configured but invalid; fail loud
		// rather than silently dropping document bytes.
		log.Fatalf("blob backend: %v", err)
	}
	s := &Server{
		db: db, dialect: dialect, clock: domain.SystemClock{}, hub: NewHub(),
		blobs: backend, maxBlobSize: maxBlobSizeFromEnv(),
		authLimiter: NewRateLimiter(authRatePerMinute, authBurst),
	}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// DB returns the underlying store, so a wrapping binary (the cloud) can run its own
// schema/queries (e.g. the subscriptions table) against the same database.
func (s *Server) DB() *sql.DB { return s.db }

// Dialect reports the active SQL dialect ("postgres" or "sqlite").
func (s *Server) Dialect() string { return s.dialect }

// Rebind adapts '?' placeholders to the active dialect, exported for wrapping binaries
// that share this store.
func (s *Server) Rebind(q string) string { return s.rebind(q) }

// guard authorizes a sync-gated request. It returns true when the request may proceed;
// when a guard is configured and rejects, it writes 403 and returns false.
func (s *Server) guard(w http.ResponseWriter, r *http.Request) bool {
	if s.syncGuard == nil {
		return true
	}
	if err := s.syncGuard(r.Context(), UserID(r)); err != nil {
		writeErr(w, http.StatusForbidden, err.Error())
		return false
	}
	return true
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
	// Credential endpoints are rate-limited per client IP (per path) to bound brute-force
	// and account-creation abuse.
	mux.Handle("POST /v1/auth/register", s.authLimiter.Limit(IPPathKey, s.handleRegister))
	mux.Handle("POST /v1/auth/login", s.authLimiter.Limit(IPPathKey, s.handleLogin))
	mux.Handle("POST /v1/auth/refresh", s.authLimiter.Limit(IPPathKey, s.handleRefresh))
	// Account self-service (shared by open-core + cloud): profile + credential changes.
	mux.Handle("GET /v1/account", s.authed(s.handleAccount))
	mux.Handle("POST /v1/account/profile", s.authed(s.handleUpdateProfile))
	mux.Handle("POST /v1/account/email", s.authed(s.handleUpdateEmail))
	mux.Handle("POST /v1/account/password", s.authed(s.handleUpdatePassword))
	mux.Handle("GET /v1/sync/pull", s.authed(s.handlePull))
	mux.Handle("POST /v1/sync/push", s.authed(s.handlePush))
	mux.Handle("GET /v1/sync/events", s.authed(s.handleEvents))
	// Manual calendar refresh: re-fetch this account's ICS feeds now (PLAN §6.7).
	mux.Handle("POST /v1/calendar/refresh", s.authed(s.handleCalendarRefresh))
	// Document bytes: content-addressed, streamed to/from object storage (PLAN §6.9).
	mux.Handle("PUT /v1/blobs/{sha256}", s.authed(s.handleBlobPut))
	mux.Handle("GET /v1/blobs/{sha256}", s.authed(s.handleBlobGet))
	cors := s.corsMW
	if cors == nil {
		cors = CORS([]string{"*"}) // dev-friendly default (open-core server)
	}
	return cors(mux)
}

// CORS returns a middleware applying cross-origin headers for the given origins with a
// bearer token (no cookies). A single "*" allows any origin. Otherwise the request's
// Origin is echoed only when it appears in the allowlist, with Vary: Origin so caches key
// on it; a non-matching cross-origin request simply gets no allow header and is blocked by
// the browser. Preflight OPTIONS requests short-circuit with 204.
func CORS(origins []string) func(http.Handler) http.Handler {
	allowAll := len(origins) == 1 && strings.TrimSpace(origins[0]) == "*"
	allowed := make(map[string]bool, len(origins))
	for _, o := range origins {
		if o = strings.TrimSpace(o); o != "" {
			allowed[o] = true
		}
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := w.Header()
			switch origin := r.Header.Get("Origin"); {
			case allowAll:
				h.Set("Access-Control-Allow-Origin", "*")
			case origin != "" && allowed[origin]:
				h.Set("Access-Control-Allow-Origin", origin)
				h.Add("Vary", "Origin")
			}
			h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			h.Set("Access-Control-Max-Age", "600")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

type ctxKey int

const userIDKey ctxKey = 0

func userID(r *http.Request) string {
	v, _ := r.Context().Value(userIDKey).(string)
	return v
}

// UserID returns the authenticated user id from the request context (populated by
// Authed). Exported for wrapping binaries that add their own authenticated routes.
func UserID(r *http.Request) string { return userID(r) }

// Authed requires a valid bearer token and injects the user id, exported so a wrapping
// binary (the cloud) can protect its own endpoints (e.g. billing) with the same session
// check used by the sync API.
func (s *Server) Authed(next http.HandlerFunc) http.Handler { return s.authed(next) }

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
