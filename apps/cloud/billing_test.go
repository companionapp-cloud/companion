package main

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"companion/syncserver"

	stripe "github.com/stripe/stripe-go/v81"
)

func newTestBilling(t *testing.T) *billing {
	t.Helper()
	db, dialect, err := syncserver.OpenDB(":memory:")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if err := applyCloudSchema(db, dialect); err != nil {
		t.Fatalf("apply cloud schema: %v", err)
	}
	return &billing{db: db, dialect: dialect}
}

func seedSubscription(t *testing.T, b *billing, userID, customerID, subID, status string) {
	t.Helper()
	now := time.Now().UTC().Format(timeFormat)
	if _, err := b.db.Exec(b.rebind(`
		INSERT INTO subscriptions (user_id, plan_id, source, stripe_customer_id, stripe_subscription_id, status, created_at, updated_at)
		VALUES (?, 'default', 'stripe', ?, ?, ?, ?, ?);`),
		userID, nullify(customerID), nullify(subID), status, now, now); err != nil {
		t.Fatalf("seed subscription: %v", err)
	}
}

func statusOf(t *testing.T, b *billing, userID string) (status, subID string) {
	t.Helper()
	var s string
	var sub sql.NullString
	if err := b.db.QueryRow(b.rebind(
		`SELECT status, stripe_subscription_id FROM subscriptions WHERE user_id = ?;`), userID).Scan(&s, &sub); err != nil {
		t.Fatalf("read subscription: %v", err)
	}
	return s, sub.String
}

// A lifecycle event for an OLD subscription (same customer, different subscription id) must
// not overwrite the row that tracks the current subscription — otherwise canceling a
// superseded subscription would lock a paying user out of sync.
func TestUpdateByCustomerIgnoresStaleSubscription(t *testing.T) {
	b := newTestBilling(t)
	seedSubscription(t, b, "u1", "cus_1", "sub_new", "active")

	b.updateByCustomer(context.Background(), "cus_1", "sub_old", "canceled", "", false)

	if status, sub := statusOf(t, b, "u1"); status != "active" || sub != "sub_new" {
		t.Errorf("stale cancel clobbered current sub: status=%q sub=%q, want active/sub_new", status, sub)
	}

	// The event for the CURRENT subscription does apply.
	b.updateByCustomer(context.Background(), "cus_1", "sub_new", "canceled", "", false)
	if status, _ := statusOf(t, b, "u1"); status != "canceled" {
		t.Errorf("current-sub cancel not applied: status=%q, want canceled", status)
	}
}

// The first lifecycle event after checkout (before the subscription id was recorded) binds
// the subscription id onto the customer's row.
func TestUpdateByCustomerBindsWhenUnset(t *testing.T) {
	b := newTestBilling(t)
	seedSubscription(t, b, "u2", "cus_2", "", "active")

	b.updateByCustomer(context.Background(), "cus_2", "sub_x", "active", "", false)

	if status, sub := statusOf(t, b, "u2"); status != "active" || sub != "sub_x" {
		t.Errorf("expected sub_x bound to the row, got status=%q sub=%q", status, sub)
	}
}

// checkout.session.completed with an unpaid async payment records pending, not active, so an
// unpaid user can't sync until the payment clears.
func TestApplyCheckoutSessionUnpaidIsPending(t *testing.T) {
	b := newTestBilling(t)
	cs := &stripe.CheckoutSession{
		ClientReferenceID: "u3",
		Customer:          &stripe.Customer{ID: "cus_3"},
		Subscription:      &stripe.Subscription{ID: "sub_3"},
	}

	b.applyCheckoutSession(context.Background(), cs, "pending")
	if status, _ := statusOf(t, b, "u3"); status != "pending" {
		t.Errorf("unpaid checkout status = %q, want pending", status)
	}

	// The async-payment-succeeded promotion flips it to active.
	b.applyCheckoutSession(context.Background(), cs, "active")
	if status, _ := statusOf(t, b, "u3"); status != "active" {
		t.Errorf("after async success status = %q, want active", status)
	}
}

// seedAdminGrant gives a user the comped 'free' plan the admin back-office hands out: no
// Stripe ids, so there is nothing for the portal to cancel.
func seedAdminGrant(t *testing.T, b *billing, userID string) {
	t.Helper()
	now := time.Now().UTC().Format(timeFormat)
	if _, err := b.db.Exec(b.rebind(`
		INSERT INTO subscriptions (user_id, plan_id, source, status, created_at, updated_at)
		VALUES (?, 'free', 'admin', 'active', ?, ?);`), userID, now, now); err != nil {
		t.Fatalf("seed admin grant: %v", err)
	}
}

// A scheduled cancellation is mirrored locally and reported to the portal, sync keeps
// working until the period the user paid for runs out, and resuming undoes it.
func TestCancelAtPeriodEndRoundTrip(t *testing.T) {
	b := newTestBilling(t)
	ctx := context.Background()
	seedSubscription(t, b, "u4", "cus_4", "sub_4", "active")
	end := time.Now().Add(20 * 24 * time.Hour).UTC().Format(timeFormat)

	if _, err := b.applySubscription(ctx, "sub_4", "active", end, true); err != nil {
		t.Fatalf("schedule cancel: %v", err)
	}
	st, err := b.state(ctx, "u4")
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	if !st.CancelAtPeriodEnd || !st.Cancelable || st.CurrentPeriodEnd != end {
		t.Errorf("after cancel: %+v, want it cancelable, ending at %s", st, end)
	}
	if err := b.Guard(ctx, "u4"); err != nil {
		t.Errorf("Guard during a scheduled cancellation = %v, want sync to keep working", err)
	}

	// Resuming clears the flag, and a lifecycle event with no period end (Stripe accounts on
	// an API version that moved it onto the items send none) keeps the date we already had.
	if _, err := b.applySubscription(ctx, "sub_4", "active", "", false); err != nil {
		t.Fatalf("resume: %v", err)
	}
	st, err = b.state(ctx, "u4")
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	if st.CancelAtPeriodEnd || st.CurrentPeriodEnd != end {
		t.Errorf("after resume: %+v, want no cancellation and period end %s", st, end)
	}
}

// Only a live Stripe subscription can be canceled from the portal: a comped grant has
// nothing to cancel at Stripe, and a lapsed subscription has nothing to cancel at all.
func TestStateCancelableOnlyForLiveStripeSubscriptions(t *testing.T) {
	b := newTestBilling(t)
	ctx := context.Background()
	seedAdminGrant(t, b, "granted")
	seedSubscription(t, b, "lapsed", "cus_5", "sub_5", "canceled")

	for _, tc := range []struct{ user, source string }{{"granted", "admin"}, {"lapsed", "stripe"}, {"stranger", ""}} {
		st, err := b.state(ctx, tc.user)
		if err != nil {
			t.Fatalf("state %s: %v", tc.user, err)
		}
		if st.Cancelable {
			t.Errorf("%s reported cancelable: %+v", tc.user, st)
		}
		if st.source != tc.source {
			t.Errorf("%s source = %q, want %q", tc.user, st.source, tc.source)
		}
	}
	if st, _ := b.state(ctx, "stranger"); st.Status != "none" {
		t.Errorf("a user with no subscription has status %q, want none", st.Status)
	}
}

// Subscribing again after cancelling starts clean: the new subscription must not inherit the
// cancellation scheduled on the one it replaces.
func TestCheckoutClearsScheduledCancellation(t *testing.T) {
	b := newTestBilling(t)
	ctx := context.Background()
	seedSubscription(t, b, "u6", "cus_6", "sub_6", "active")
	if _, err := b.applySubscription(ctx, "sub_6", "canceled", "", true); err != nil {
		t.Fatalf("schedule cancel: %v", err)
	}

	b.applyCheckoutSession(ctx, &stripe.CheckoutSession{
		ClientReferenceID: "u6",
		Customer:          &stripe.Customer{ID: "cus_6"},
		Subscription:      &stripe.Subscription{ID: "sub_7"},
	}, "active")

	st, err := b.state(ctx, "u6")
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	if st.CancelAtPeriodEnd || !st.Cancelable {
		t.Errorf("after re-subscribing: %+v, want a live subscription with no cancellation", st)
	}
}
