package syncserver

import (
	"log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

// SetupLogging configures the process-wide structured logger from the environment and
// returns it. LOG_FORMAT selects "json" or "text" (default text); LOG_LEVEL is one of
// debug/info/warn/error (default info). Both the open-core server and the cloud call this
// at startup so their operational logs and the request middleware share one format.
func SetupLogging() *slog.Logger {
	opts := &slog.HandlerOptions{Level: parseLevel(os.Getenv("LOG_LEVEL"))}
	var h slog.Handler
	if strings.EqualFold(os.Getenv("LOG_FORMAT"), "json") {
		h = slog.NewJSONHandler(os.Stdout, opts)
	} else {
		h = slog.NewTextHandler(os.Stdout, opts)
	}
	logger := slog.New(h)
	slog.SetDefault(logger)
	// Route the standard log package (used by background jobs and third-party libs) through
	// slog so every line shares one format. These arrive at info level; HTTP requests and
	// explicit app logs carry their own levels.
	log.SetFlags(0)
	log.SetOutput(slogBridge{logger})
	return logger
}

// slogBridge adapts the standard log package's io.Writer to slog.
type slogBridge struct{ logger *slog.Logger }

func (b slogBridge) Write(p []byte) (int, error) {
	b.logger.Info(strings.TrimRight(string(p), "\n"))
	return len(p), nil
}

func parseLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// LogRequests is middleware that logs one line per HTTP request once it completes: method,
// path, status, response size, duration, and client IP. The level scales with the status
// (5xx→error, 4xx→warn, else info). It is Flusher-aware so streaming responses (SSE) keep
// working through the wrapper.
func LogRequests(logger *slog.Logger) func(http.Handler) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := &respRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rec, r)
			logger.LogAttrs(r.Context(), levelForStatus(rec.status), "http request",
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.Int("status", rec.status),
				slog.Int("bytes", rec.bytes),
				slog.Duration("dur", time.Since(start)),
				slog.String("ip", clientIP(r)),
			)
		})
	}
}

func levelForStatus(status int) slog.Level {
	switch {
	case status >= 500:
		return slog.LevelError
	case status >= 400:
		return slog.LevelWarn
	default:
		return slog.LevelInfo
	}
}

// trustProxy controls whether clientIP believes the X-Forwarded-For header. A direct client
// can set XFF to any value, so trusting it unconditionally lets an attacker spoof their
// apparent IP and defeat IP-keyed rate limiting. Enable it (TRUST_PROXY=1) only when the
// service actually runs behind a proxy that overwrites XFF.
var trustProxy = envTrue("TRUST_PROXY")

func envTrue(k string) bool {
	switch strings.TrimSpace(strings.ToLower(os.Getenv(k))) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// clientIP returns the best-effort client IP: the first hop of X-Forwarded-For when a
// trusted proxy is configured, else the connection's remote address without its port.
func clientIP(r *http.Request) string {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if i := strings.IndexByte(xff, ','); i >= 0 {
				return strings.TrimSpace(xff[:i])
			}
			return strings.TrimSpace(xff)
		}
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

// ClientIP returns the best-effort client IP (see clientIP), exported so a wrapping binary
// (the cloud) can key its own rate limiting on the same value.
func ClientIP(r *http.Request) string { return clientIP(r) }

// respRecorder captures the status code and byte count while delegating everything else,
// including Flush so SSE streams still flush through it.
type respRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
	wrote  bool
}

func (r *respRecorder) WriteHeader(code int) {
	if !r.wrote {
		r.status = code
		r.wrote = true
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *respRecorder) Write(b []byte) (int, error) {
	r.wrote = true
	n, err := r.ResponseWriter.Write(b)
	r.bytes += n
	return n, err
}

func (r *respRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
