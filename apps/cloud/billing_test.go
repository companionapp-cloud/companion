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

	b.updateByCustomer(context.Background(), "cus_1", "sub_old", "canceled", "")

	if status, sub := statusOf(t, b, "u1"); status != "active" || sub != "sub_new" {
		t.Errorf("stale cancel clobbered current sub: status=%q sub=%q, want active/sub_new", status, sub)
	}

	// The event for the CURRENT subscription does apply.
	b.updateByCustomer(context.Background(), "cus_1", "sub_new", "canceled", "")
	if status, _ := statusOf(t, b, "u1"); status != "canceled" {
		t.Errorf("current-sub cancel not applied: status=%q, want canceled", status)
	}
}

// The first lifecycle event after checkout (before the subscription id was recorded) binds
// the subscription id onto the customer's row.
func TestUpdateByCustomerBindsWhenUnset(t *testing.T) {
	b := newTestBilling(t)
	seedSubscription(t, b, "u2", "cus_2", "", "active")

	b.updateByCustomer(context.Background(), "cus_2", "sub_x", "active", "")

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
