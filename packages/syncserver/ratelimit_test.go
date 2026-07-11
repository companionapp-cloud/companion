package syncserver

import (
	"testing"
	"time"
)

// A fresh key may burst up to capacity, is then blocked, and recovers as tokens refill.
func TestRateLimiterBurstAndRefill(t *testing.T) {
	now := time.Unix(0, 0)
	rl := NewRateLimiter(60, 3) // 1 token/sec, burst 3
	rl.now = func() time.Time { return now }

	for i := 0; i < 3; i++ {
		if !rl.Allow("k") {
			t.Fatalf("request %d within burst should be allowed", i)
		}
	}
	if rl.Allow("k") {
		t.Fatal("4th request should be blocked once the burst is spent")
	}

	// One second later, exactly one token has refilled.
	now = now.Add(time.Second)
	if !rl.Allow("k") {
		t.Fatal("a token should have refilled after 1s")
	}
	if rl.Allow("k") {
		t.Fatal("only one token should have refilled")
	}
}

// Different keys have independent budgets.
func TestRateLimiterPerKey(t *testing.T) {
	now := time.Unix(0, 0)
	rl := NewRateLimiter(60, 1)
	rl.now = func() time.Time { return now }

	if !rl.Allow("a") || !rl.Allow("b") {
		t.Fatal("distinct keys should not share a budget")
	}
	if rl.Allow("a") {
		t.Fatal("key a is spent")
	}
}

// A disabled limiter (non-positive rate/burst) and an empty key always allow.
func TestRateLimiterFailOpen(t *testing.T) {
	disabled := NewRateLimiter(0, 0)
	for i := 0; i < 100; i++ {
		if !disabled.Allow("k") {
			t.Fatal("disabled limiter must always allow")
		}
	}
	rl := NewRateLimiter(60, 1)
	rl.Allow("") // consumes nothing
	if !rl.Allow("") {
		t.Fatal("empty key must always allow")
	}
}
