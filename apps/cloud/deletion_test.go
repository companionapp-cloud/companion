package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"companion/syncserver"

	stripe "github.com/stripe/stripe-go/v81"
)

// fakeStripe stands in for Stripe's subscription API and records every call. The hooks can run
// on server goroutines, so it is locked.
type fakeStripe struct {
	mu           sync.Mutex
	unconfigured bool
	err          error    // returned by every call when set
	updates      []bool   // cancel_at_period_end values sent, in order
	cancels      []string // subscriptions cancelled outright
}

func (f *fakeStripe) Configured() bool { return !f.unconfigured }

func (f *fakeStripe) Update(id string, p *stripe.SubscriptionParams) (*stripe.Subscription, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	cancel := p.CancelAtPeriodEnd != nil && *p.CancelAtPeriodEnd
	f.updates = append(f.updates, cancel)
	return &stripe.Subscription{ID: id, Status: stripe.SubscriptionStatusActive, CancelAtPeriodEnd: cancel}, nil
}

func (f *fakeStripe) Cancel(id string, _ *stripe.SubscriptionCancelParams) (*stripe.Subscription, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	f.cancels = append(f.cancels, id)
	return &stripe.Subscription{ID: id, Status: stripe.SubscriptionStatusCanceled}, nil
}

func (f *fakeStripe) calls() (updates []bool, cancels []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]bool(nil), f.updates...), append([]string(nil), f.cancels...)
}

// subFlags reads a subscription's renewal flags; ok is false when the user has no row.
func subFlags(t *testing.T, b *billing, userID string) (cancelAtPeriodEnd, pausedForDeletion, ok bool) {
	t.Helper()
	var c, p int64
	err := b.db.QueryRow(b.rebind(
		`SELECT cancel_at_period_end, paused_for_deletion FROM subscriptions WHERE user_id = ?;`), userID).Scan(&c, &p)
	if err == sql.ErrNoRows {
		return false, false, false
	}
	if err != nil {
		t.Fatalf("read subscription: %v", err)
	}
	return c == 1, p == 1, true
}

func hasAdminRow(t *testing.T, b *billing, userID string) bool {
	t.Helper()
	var n int
	if err := b.db.QueryRow(b.rebind(`SELECT COUNT(*) FROM admin_users WHERE user_id = ?;`), userID).Scan(&n); err != nil {
		t.Fatalf("read admin_users: %v", err)
	}
	return n > 0
}

func seedAdminUser(t *testing.T, b *billing, userID string) {
	t.Helper()
	if _, err := b.db.Exec(b.rebind(`INSERT INTO admin_users (user_id, created_at) VALUES (?, ?);`),
		userID, time.Now().UTC().Format(timeFormat)); err != nil {
		t.Fatalf("seed admin: %v", err)
	}
}

// Requesting deletion stops a live subscription renewing and marks the pause as ours; a
// sign-in that takes the deletion back turns renewal on again and clears the mark.
func TestDeletionPausesAndResumesRenewal(t *testing.T) {
	b := newTestBilling(t)
	fake := &fakeStripe{}
	b.subs = fake
	ctx := context.Background()
	hooks := b.accountLifecycle()
	seedSubscription(t, b, "u1", "cus_1", "sub_1", "active")

	hooks.DeletionRequested(ctx, "u1", time.Now().Add(30*24*time.Hour))
	if updates, _ := fake.calls(); len(updates) != 1 || !updates[0] {
		t.Fatalf("Stripe updates after the request = %v, want [cancel at period end]", updates)
	}
	if cancel, paused, _ := subFlags(t, b, "u1"); !cancel || !paused {
		t.Errorf("after the request cancel_at_period_end=%v paused_for_deletion=%v, want both set", cancel, paused)
	}
	// Asking again changes nothing: the renewal is already off.
	hooks.DeletionRequested(ctx, "u1", time.Now().Add(30*24*time.Hour))
	if updates, _ := fake.calls(); len(updates) != 1 {
		t.Errorf("a repeat request called Stripe again: %v", updates)
	}

	hooks.DeletionCancelled(ctx, "u1")
	if updates, _ := fake.calls(); len(updates) != 2 || updates[1] {
		t.Fatalf("Stripe updates after reactivation = %v, want a resume", updates)
	}
	if cancel, paused, _ := subFlags(t, b, "u1"); cancel || paused {
		t.Errorf("after reactivation cancel_at_period_end=%v paused_for_deletion=%v, want both clear", cancel, paused)
	}
}

// A cancellation the user scheduled before asking for deletion is theirs: deletion neither
// claims it nor resumes it on reactivation.
func TestDeletionLeavesUserCancellationAlone(t *testing.T) {
	b := newTestBilling(t)
	fake := &fakeStripe{}
	b.subs = fake
	ctx := context.Background()
	hooks := b.accountLifecycle()
	seedSubscription(t, b, "u2", "cus_2", "sub_2", "active")
	if _, err := b.applySubscription(ctx, "sub_2", "active", "", true); err != nil {
		t.Fatalf("schedule cancel: %v", err)
	}

	hooks.DeletionRequested(ctx, "u2", time.Now().Add(30*24*time.Hour))
	hooks.DeletionCancelled(ctx, "u2")
	if updates, _ := fake.calls(); len(updates) != 0 {
		t.Errorf("Stripe was called for a user-scheduled cancellation: %v", updates)
	}
	if cancel, paused, _ := subFlags(t, b, "u2"); !cancel || paused {
		t.Errorf("cancel_at_period_end=%v paused_for_deletion=%v, want the user's cancellation kept and no pause", cancel, paused)
	}
}

// When Stripe can't be reached (or isn't configured) the request goes ahead without a pause:
// nothing is marked, and the purge cancels the subscription later anyway.
func TestDeletionPauseFailureMarksNothing(t *testing.T) {
	for name, fake := range map[string]*fakeStripe{
		"stripe error": {err: errors.New("stripe is down")},
		"unconfigured": {unconfigured: true},
	} {
		t.Run(name, func(t *testing.T) {
			b := newTestBilling(t)
			b.subs = fake
			seedSubscription(t, b, "u3", "cus_3", "sub_3", "active")
			b.accountLifecycle().DeletionRequested(context.Background(), "u3", time.Now().Add(30*24*time.Hour))
			if cancel, paused, _ := subFlags(t, b, "u3"); cancel || paused {
				t.Errorf("cancel_at_period_end=%v paused_for_deletion=%v after a failed pause, want both clear", cancel, paused)
			}
		})
	}
}

// An admin grant isn't billed, so deletion leaves Stripe alone, and the purge just removes the
// cloud rows (the grant and the admin membership).
func TestDeletionOfAdminGrant(t *testing.T) {
	b := newTestBilling(t)
	fake := &fakeStripe{}
	b.subs = fake
	ctx := context.Background()
	hooks := b.accountLifecycle()
	seedAdminGrant(t, b, "comped")
	seedAdminUser(t, b, "comped")

	hooks.DeletionRequested(ctx, "comped", time.Now().Add(30*24*time.Hour))
	if err := hooks.Purge(ctx, "comped"); err != nil {
		t.Fatalf("purge: %v", err)
	}
	if updates, cancels := fake.calls(); len(updates) != 0 || len(cancels) != 0 {
		t.Errorf("Stripe was called for an admin grant: updates=%v cancels=%v", updates, cancels)
	}
	if _, _, ok := subFlags(t, b, "comped"); ok {
		t.Error("the purge left the subscription row")
	}
	if hasAdminRow(t, b, "comped") {
		t.Error("the purge left the admin membership")
	}
}

// The purge cancels any subscription that could still charge, then deletes the cloud rows.
func TestPurgeCancelsBillableSubscription(t *testing.T) {
	for _, status := range []string{"active", "trialing", "past_due", "unpaid", "pending"} {
		t.Run(status, func(t *testing.T) {
			b := newTestBilling(t)
			fake := &fakeStripe{}
			b.subs = fake
			seedSubscription(t, b, "u4", "cus_4", "sub_4", status)
			seedAdminUser(t, b, "u4")

			if err := b.accountLifecycle().Purge(context.Background(), "u4"); err != nil {
				t.Fatalf("purge: %v", err)
			}
			if _, cancels := fake.calls(); len(cancels) != 1 || cancels[0] != "sub_4" {
				t.Errorf("cancels = %v, want [sub_4]", cancels)
			}
			if _, _, ok := subFlags(t, b, "u4"); ok {
				t.Error("the purge left the subscription row")
			}
			if hasAdminRow(t, b, "u4") {
				t.Error("the purge left the admin membership")
			}
		})
	}
}

// A subscription that has already ended (or none at all) needs no Stripe call; the purge
// just removes the rows.
func TestPurgeSkipsFinishedSubscription(t *testing.T) {
	for _, status := range []string{"canceled", "incomplete_expired", ""} {
		t.Run("status "+status, func(t *testing.T) {
			b := newTestBilling(t)
			fake := &fakeStripe{unconfigured: true} // any Stripe call would fail
			b.subs = fake
			if status != "" {
				seedSubscription(t, b, "u5", "cus_5", "sub_5", status)
			}
			if err := b.accountLifecycle().Purge(context.Background(), "u5"); err != nil {
				t.Fatalf("purge: %v", err)
			}
			if _, _, ok := subFlags(t, b, "u5"); ok {
				t.Error("the purge left the subscription row")
			}
		})
	}
}

// When billing can't be stopped the purge fails, so syncserver keeps the account (and the
// rows here) for the next sweep: an account is never erased while it can still be charged.
func TestPurgeRefusesWhileBillingCannotStop(t *testing.T) {
	prevKey := stripe.Key
	stripe.Key = ""
	t.Cleanup(func() { stripe.Key = prevKey })

	for name, api := range map[string]subscriptionAPI{
		"stripe error":        &fakeStripe{err: errors.New("stripe is down")},
		"unconfigured":        &fakeStripe{unconfigured: true},
		"live stripe, no key": nil, // falls back to liveStripe, which has no key
	} {
		t.Run(name, func(t *testing.T) {
			b := newTestBilling(t)
			b.subs = api
			seedSubscription(t, b, "u6", "cus_6", "sub_6", "active")
			if err := b.accountLifecycle().Purge(context.Background(), "u6"); err == nil {
				t.Fatal("purge succeeded with a live subscription it could not cancel")
			}
			if _, _, ok := subFlags(t, b, "u6"); !ok {
				t.Error("a failed purge deleted the subscription row")
			}
		})
	}
}

// A subscription Stripe no longer has counts as cancelled, so the purge can finish.
func TestPurgeTreatsMissingStripeSubscriptionAsCancelled(t *testing.T) {
	b := newTestBilling(t)
	b.subs = &fakeStripe{err: &stripe.Error{Code: stripe.ErrorCodeResourceMissing, Msg: "No such subscription"}}
	seedSubscription(t, b, "u7", "cus_7", "sub_7", "active")
	if err := b.accountLifecycle().Purge(context.Background(), "u7"); err != nil {
		t.Fatalf("purge: %v", err)
	}
	if _, _, ok := subFlags(t, b, "u7"); ok {
		t.Error("the purge left the subscription row")
	}
}

// End to end through the shared sync API with the hooks wired as main wires them: requesting
// deletion pauses renewal, signing back in resumes it, and the purge cancels the subscription
// before the account and its billing rows are erased.
func TestAccountDeletionThroughSyncServer(t *testing.T) {
	db, dialect, err := syncserver.OpenDB(":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if err := applyCloudSchema(db, dialect); err != nil {
		t.Fatalf("apply cloud schema: %v", err)
	}
	fake := &fakeStripe{}
	b := &billing{db: db, dialect: dialect, subs: fake}
	srv := syncserver.New(db, dialect, syncserver.WithAccountLifecycle(b.accountLifecycle()))
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	post := func(path, token string, body any, out any) int {
		t.Helper()
		buf, _ := json.Marshal(body)
		req, _ := http.NewRequest(http.MethodPost, ts.URL+path, bytes.NewReader(buf))
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("POST %s: %v", path, err)
		}
		defer resp.Body.Close()
		if out != nil {
			json.NewDecoder(resp.Body).Decode(out)
		}
		return resp.StatusCode
	}
	cred := map[string]string{"email": "cloud@b.co", "password": "password"}
	var reg struct{ Token, UserID string }
	if status := post("/v1/auth/register", "", cred, &reg); status != http.StatusOK {
		t.Fatalf("register = %d", status)
	}
	seedSubscription(t, b, reg.UserID, "cus_8", "sub_8", "active")

	if status := post("/v1/account/delete", reg.Token, map[string]string{"password": "password"}, nil); status != http.StatusOK {
		t.Fatalf("delete = %d", status)
	}
	if cancel, paused, _ := subFlags(t, b, reg.UserID); !cancel || !paused {
		t.Fatalf("after the request cancel_at_period_end=%v paused_for_deletion=%v, want both set", cancel, paused)
	}

	var back struct {
		Token       string
		Reactivated bool
	}
	if status := post("/v1/auth/login", "", cred, &back); status != http.StatusOK || !back.Reactivated {
		t.Fatalf("login = %d reactivated=%v, want 200 and true", status, back.Reactivated)
	}
	if cancel, paused, _ := subFlags(t, b, reg.UserID); cancel || paused {
		t.Fatalf("after reactivation cancel_at_period_end=%v paused_for_deletion=%v, want both clear", cancel, paused)
	}

	// Ask again, then let the grace period lapse (backdated, since the server's clock is real).
	if status := post("/v1/account/delete", back.Token, map[string]string{"password": "password"}, nil); status != http.StatusOK {
		t.Fatalf("second delete = %d", status)
	}
	if _, err := db.Exec(b.rebind(`UPDATE users SET deleting_at = ? WHERE id = ?;`),
		time.Now().Add(-time.Minute).UTC().Format(timeFormat), reg.UserID); err != nil {
		t.Fatalf("backdate: %v", err)
	}
	if n, err := srv.PurgeDeletedAccounts(context.Background()); n != 1 || err != nil {
		t.Fatalf("purge = %d, %v; want 1, nil", n, err)
	}
	if _, cancels := fake.calls(); len(cancels) != 1 || cancels[0] != "sub_8" {
		t.Errorf("cancels = %v, want [sub_8]", cancels)
	}
	if _, _, ok := subFlags(t, b, reg.UserID); ok {
		t.Error("the purge left the subscription row")
	}
	var users int
	if err := db.QueryRow(b.rebind(`SELECT COUNT(*) FROM users WHERE id = ?;`), reg.UserID).Scan(&users); err != nil || users != 0 {
		t.Errorf("users rows after the purge = %d (%v), want 0", users, err)
	}
}
