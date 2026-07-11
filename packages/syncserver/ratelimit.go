package syncserver

import (
	"net/http"
	"sync"
	"time"
)

// RateLimiter is a token-bucket limiter keyed by an arbitrary string (client IP, user id,
// …). Each key refills at a fixed rate and tolerates a short burst; it is safe for
// concurrent use and prunes idle buckets so the map can't grow without bound. This is coarse
// abuse protection (login stuffing, verification-email flooding), not precise quota
// accounting. It is in-memory and per-process: a multi-instance deployment needs a shared
// store (e.g. Redis) for a global limit.
type RateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*tokenBucket
	rate    float64 // tokens per second
	burst   float64 // bucket capacity
	lastGC  time.Time
	now     func() time.Time // injectable for tests
}

type tokenBucket struct {
	tokens float64
	last   time.Time
}

// NewRateLimiter builds a limiter allowing perMinute requests per key on average, tolerating
// short bursts up to burst. A non-positive perMinute or burst disables limiting entirely
// (Allow always returns true), so callers can wire it unconditionally.
func NewRateLimiter(perMinute float64, burst int) *RateLimiter {
	return &RateLimiter{
		buckets: map[string]*tokenBucket{},
		rate:    perMinute / 60.0,
		burst:   float64(burst),
		now:     time.Now,
	}
}

// Allow reports whether a request for key may proceed, consuming one token when it does. An
// empty key or a disabled limiter always allows (fail-open, so a missing key never blocks).
func (rl *RateLimiter) Allow(key string) bool {
	if rl == nil || rl.rate <= 0 || rl.burst <= 0 || key == "" {
		return true
	}
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := rl.now()
	rl.gc(now)

	b := rl.buckets[key]
	if b == nil {
		b = &tokenBucket{tokens: rl.burst, last: now}
		rl.buckets[key] = b
	}
	// Refill for elapsed time, capped at the burst capacity.
	b.tokens += now.Sub(b.last).Seconds() * rl.rate
	if b.tokens > rl.burst {
		b.tokens = rl.burst
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// gc drops buckets idle long enough to have fully refilled — indistinguishable from a fresh
// one, so forgetting them changes nothing — bounding memory. The caller holds the lock.
func (rl *RateLimiter) gc(now time.Time) {
	if now.Sub(rl.lastGC) < time.Minute {
		return
	}
	rl.lastGC = now
	refill := rl.burst / rl.rate // seconds to refill an empty bucket
	for k, b := range rl.buckets {
		if now.Sub(b.last).Seconds() > refill {
			delete(rl.buckets, k)
		}
	}
}

// Limit wraps a handler, rejecting requests whose key exhausts its bucket with 429 and a
// Retry-After hint. keyFn derives the bucket key from the request; a "" key skips limiting
// for that request.
func (rl *RateLimiter) Limit(keyFn func(*http.Request) string, next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !rl.Allow(keyFn(r)) {
			w.Header().Set("Retry-After", "60")
			writeErr(w, http.StatusTooManyRequests, "too many requests; slow down and try again shortly")
			return
		}
		next(w, r)
	})
}

// IPPathKey keys a bucket by client IP and request path, so distinct endpoints don't share
// (and starve) one budget. Suitable for anonymous routes.
func IPPathKey(r *http.Request) string { return ClientIP(r) + " " + r.URL.Path }

// UserKey keys a bucket by the authenticated user id (populated by Authed). Use it on
// authenticated routes so the limit is per-account rather than per-IP.
func UserKey(r *http.Request) string { return UserID(r) }
