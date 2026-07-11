package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"time"

	"companion/syncserver"

	stripe "github.com/stripe/stripe-go/v81"
	"github.com/stripe/stripe-go/v81/checkout/session"
	"github.com/stripe/stripe-go/v81/invoice"
	"github.com/stripe/stripe-go/v81/webhook"
)

const timeFormat = time.RFC3339Nano

// billing wraps Stripe subscription state around the sync API. A subscriptions row
// (correlated to Stripe by customer/subscription id) authorizes a user to sync; without
// an active one, Guard rejects and syncserver returns 403. Everything is configured from
// the environment at runtime — no keys are compiled in.
type billing struct {
	db      *sql.DB
	dialect string

	webhookSecret string // STRIPE_WEBHOOK_SECRET: verifies inbound webhook signatures
	baseURL       string // CLOUD_BASE_URL: origin used to build Checkout return URLs
}

// newBilling reads Stripe configuration from the environment and sets the global API key.
// Missing keys are tolerated (the endpoints simply error at call time) so the binary can
// boot in dev without Stripe — the sync 403 gate still works via manual subscription rows.
func newBilling(db *sql.DB, dialect string) *billing {
	if k := os.Getenv("STRIPE_SECRET_KEY"); k != "" {
		stripe.Key = k
	}
	base := os.Getenv("CLOUD_BASE_URL")
	if base == "" {
		base = "http://localhost:8080"
	}
	webhookSecret := os.Getenv("STRIPE_WEBHOOK_SECRET")
	// Log a masked fingerprint at boot so a secret mismatch (the usual cause of 400s on
	// the webhook) is obvious — compare it against `stripe listen --print-secret`. The raw
	// secret is never logged: stdout/log files are too easy to leak.
	if webhookSecret == "" {
		slog.Warn("billing: webhook signature verification disabled (STRIPE_WEBHOOK_SECRET not set)")
	} else {
		slog.Info("billing: webhook secret loaded", "fingerprint", maskSecret(webhookSecret))
	}
	return &billing{
		db:            db,
		dialect:       dialect,
		webhookSecret: webhookSecret,
		baseURL:       base,
	}
}

// maskSecret renders a secret as a comparable fingerprint — its prefix, last four
// characters, and length — without exposing the full value in logs.
func maskSecret(s string) string {
	if len(s) <= 12 {
		return "(set, len " + strconv.Itoa(len(s)) + ")"
	}
	return s[:8] + "…" + s[len(s)-4:] + " (len " + strconv.Itoa(len(s)) + ")"
}

func (b *billing) rebind(q string) string { return rebind(b.dialect, q) }

// Guard is the syncserver.WithSyncGuard hook: it authorizes every sync-gated request. A
// user may sync only while their subscription is active or trialing; otherwise the sync
// endpoints return 403 with this error's message (PLAN — cloud gate).
func (b *billing) Guard(ctx context.Context, userID string) error {
	var status string
	err := b.db.QueryRowContext(ctx, b.rebind(
		`SELECT status FROM subscriptions WHERE user_id = ?;`), userID).Scan(&status)
	if err == sql.ErrNoRows {
		return errors.New("subscription required")
	}
	if err != nil {
		return errors.New("subscription lookup failed")
	}
	switch stripe.SubscriptionStatus(status) {
	case stripe.SubscriptionStatusActive, stripe.SubscriptionStatusTrialing:
		return nil
	default:
		return errors.New("subscription required")
	}
}

// handleCheckout starts a Stripe hosted Checkout for the subscription price and returns
// its URL. client_reference_id carries our user id so the webhook can tie the resulting
// subscription back to the account.
func (b *billing) handleCheckout(w http.ResponseWriter, r *http.Request) {
	uid := syncserver.UserID(r)
	// Email verification is mandatory before subscribing (checked first so the user gets
	// this actionable error regardless of billing configuration).
	if !isEmailVerified(r.Context(), b.db, b.dialect, uid) {
		writeErr(w, http.StatusForbidden, "verify your email before subscribing")
		return
	}
	// Refuse a second checkout while a subscription is already live: a repeat Checkout mints
	// a parallel Stripe subscription and double-bills the user. They must manage the existing
	// one (cancel/change) rather than start another.
	var existing string
	_ = b.db.QueryRowContext(r.Context(), b.rebind(
		`SELECT status FROM subscriptions WHERE user_id = ?;`), uid).Scan(&existing)
	switch stripe.SubscriptionStatus(existing) {
	case stripe.SubscriptionStatusActive, stripe.SubscriptionStatusTrialing:
		writeErr(w, http.StatusConflict, "you already have an active subscription")
		return
	}
	if stripe.Key == "" {
		writeErr(w, http.StatusServiceUnavailable, "billing is not configured")
		return
	}
	// Resolve which paid plan to charge for from the admin-managed catalog. The plan id
	// rides along in metadata so the webhook can record it on the subscription.
	planID, priceID := b.defaultPaidPlan(r.Context())
	if priceID == "" {
		writeErr(w, http.StatusServiceUnavailable, "no subscription plan is available")
		return
	}

	var email string
	if err := b.db.QueryRowContext(r.Context(), b.rebind(
		`SELECT email FROM users WHERE id = ?;`), uid).Scan(&email); err != nil {
		writeErr(w, http.StatusInternalServerError, "account lookup failed")
		return
	}

	params := &stripe.CheckoutSessionParams{
		Mode:              stripe.String(string(stripe.CheckoutSessionModeSubscription)),
		ClientReferenceID: stripe.String(uid),
		CustomerEmail:     stripe.String(email),
		LineItems: []*stripe.CheckoutSessionLineItemParams{{
			Price:    stripe.String(priceID),
			Quantity: stripe.Int64(1),
		}},
		SuccessURL: stripe.String(b.baseURL + "/?checkout=success"),
		CancelURL:  stripe.String(b.baseURL + "/?checkout=cancel"),
	}
	params.AddMetadata("plan_id", planID)
	sess, err := session.New(params)
	if err != nil {
		slog.Error("checkout: create session", "err", err)
		writeErr(w, http.StatusBadGateway, "could not start checkout")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": sess.URL})
}

// handleStatus returns the caller's current subscription state.
func (b *billing) handleStatus(w http.ResponseWriter, r *http.Request) {
	uid := syncserver.UserID(r)
	var status string
	var periodEnd sql.NullString
	err := b.db.QueryRowContext(r.Context(), b.rebind(
		`SELECT status, current_period_end FROM subscriptions WHERE user_id = ?;`), uid).Scan(&status, &periodEnd)
	if err == sql.ErrNoRows {
		writeJSON(w, http.StatusOK, map[string]any{"status": "none"})
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "status lookup failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":           status,
		"currentPeriodEnd": periodEnd.String,
	})
}

// stripeIDs returns the Stripe customer + subscription ids recorded for a user, or empty
// strings when the user has never checked out.
func (b *billing) stripeIDs(ctx context.Context, userID string) (customerID, subID string) {
	var c, s sql.NullString
	_ = b.db.QueryRowContext(ctx, b.rebind(
		`SELECT stripe_customer_id, stripe_subscription_id FROM subscriptions WHERE user_id = ?;`),
		userID).Scan(&c, &s)
	return c.String, s.String
}

// invoiceJSON is the trimmed invoice shape the portal renders.
type invoiceJSON struct {
	Number   string `json:"number"`
	Amount   int64  `json:"amount"` // total, in the currency's minor unit (e.g. cents)
	Currency string `json:"currency"`
	Status   string `json:"status"`
	Created  int64  `json:"created"` // unix seconds
	URL      string `json:"url"`     // hosted invoice page
	PDF      string `json:"pdf"`
}

// invoicesFor lists a Stripe customer's invoices (most recent first). Shared by the
// account portal (own invoices) and the admin interface (any user's invoices).
func (b *billing) invoicesFor(customerID string) ([]invoiceJSON, error) {
	out := []invoiceJSON{}
	if stripe.Key == "" || customerID == "" {
		return out, nil
	}
	params := &stripe.InvoiceListParams{Customer: stripe.String(customerID)}
	params.Limit = stripe.Int64(24)
	it := invoice.List(params)
	for it.Next() {
		in := it.Invoice()
		out = append(out, invoiceJSON{
			Number:   in.Number,
			Amount:   in.Total,
			Currency: string(in.Currency),
			Status:   string(in.Status),
			Created:  in.Created,
			URL:      in.HostedInvoiceURL,
			PDF:      in.InvoicePDF,
		})
	}
	return out, it.Err()
}

// handleInvoices lists the caller's past invoices (most recent first).
func (b *billing) handleInvoices(w http.ResponseWriter, r *http.Request) {
	customerID, _ := b.stripeIDs(r.Context(), syncserver.UserID(r))
	out, err := b.invoicesFor(customerID)
	if err != nil {
		slog.Error("invoices: list", "err", err)
		writeErr(w, http.StatusBadGateway, "could not load invoices")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"invoices": out})
}

// handleUpcoming returns the caller's next charge (the upcoming invoice Stripe would bill
// for the active subscription). Returns {"upcoming": null} when there is nothing due.
func (b *billing) handleUpcoming(w http.ResponseWriter, r *http.Request) {
	customerID, subID := b.stripeIDs(r.Context(), syncserver.UserID(r))
	if stripe.Key == "" || customerID == "" || subID == "" {
		writeJSON(w, http.StatusOK, map[string]any{"upcoming": nil})
		return
	}
	params := &stripe.InvoiceUpcomingParams{
		Customer:     stripe.String(customerID),
		Subscription: stripe.String(subID),
	}
	in, err := invoice.Upcoming(params)
	if err != nil {
		// No upcoming invoice (e.g. subscription canceled) is a normal, non-error state.
		writeJSON(w, http.StatusOK, map[string]any{"upcoming": nil})
		return
	}
	// next_payment_attempt is when Stripe will charge; fall back to the period end.
	due := in.NextPaymentAttempt
	if due == 0 {
		due = in.PeriodEnd
	}
	writeJSON(w, http.StatusOK, map[string]any{"upcoming": map[string]any{
		"amount":   in.AmountDue,
		"currency": string(in.Currency),
		"dueAt":    due,
	}})
}

// handleWebhook is Stripe's callback. It verifies the signature, then upserts the local
// subscription state so Guard reflects Stripe's source of truth. Unhandled event types
// are acknowledged with 200 so Stripe stops retrying them.
func (b *billing) handleWebhook(w http.ResponseWriter, r *http.Request) {
	payload, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "read body failed")
		return
	}
	if b.webhookSecret == "" {
		writeErr(w, http.StatusServiceUnavailable, "webhook is not configured")
		return
	}
	// Verify the HMAC signature and timestamp, but IgnoreAPIVersionMismatch: Stripe signs
	// events with the account's API version, which need not equal the version stripe-go/v81
	// targets. Without this, ConstructEvent rejects otherwise-valid events whenever the
	// account's version is on a different release train — the auth is the signature, not the
	// version string.
	event, err := webhook.ConstructEventWithOptions(
		payload, r.Header.Get("Stripe-Signature"), b.webhookSecret,
		webhook.ConstructEventOptions{IgnoreAPIVersionMismatch: true},
	)
	if err != nil {
		// A real failure now means a bad signature, a stale timestamp, or a malformed header
		// — not a version mismatch. If the secret is correct, suspect the raw body being
		// altered before it reaches here.
		slog.Warn("webhook: verification failed", "err", err)
		writeErr(w, http.StatusBadRequest, "invalid signature")
		return
	}

	switch event.Type {
	case stripe.EventTypeCheckoutSessionCompleted:
		var cs stripe.CheckoutSession
		if err := json.Unmarshal(event.Data.Raw, &cs); err != nil {
			writeErr(w, http.StatusBadRequest, "bad payload")
			return
		}
		// Only entitle immediately when Checkout collected payment (or none was required, e.g.
		// a free trial or 100%-off coupon). Asynchronous methods (bank debits, etc.) complete
		// the session "unpaid": record the linkage as pending and let the async_payment_succeeded
		// event promote it, so unpaid users can't sync in the meantime.
		status := "active"
		if cs.PaymentStatus == stripe.CheckoutSessionPaymentStatusUnpaid {
			status = "pending"
		}
		b.applyCheckoutSession(r.Context(), &cs, status)

	case stripe.EventTypeCheckoutSessionAsyncPaymentSucceeded:
		var cs stripe.CheckoutSession
		if err := json.Unmarshal(event.Data.Raw, &cs); err != nil {
			writeErr(w, http.StatusBadRequest, "bad payload")
			return
		}
		// The deferred payment cleared; the pending row from checkout.session.completed
		// becomes active.
		b.applyCheckoutSession(r.Context(), &cs, "active")

	case stripe.EventTypeCustomerSubscriptionUpdated, stripe.EventTypeCustomerSubscriptionDeleted:
		var sub stripe.Subscription
		if err := json.Unmarshal(event.Data.Raw, &sub); err != nil {
			writeErr(w, http.StatusBadRequest, "bad payload")
			return
		}
		var customerID string
		if sub.Customer != nil {
			customerID = sub.Customer.ID
		}
		periodEnd := ""
		if sub.CurrentPeriodEnd > 0 {
			periodEnd = time.Unix(sub.CurrentPeriodEnd, 0).UTC().Format(timeFormat)
		}
		b.updateByCustomer(r.Context(), customerID, sub.ID, string(sub.Status), periodEnd)
	}

	// Record that a signed webhook was successfully processed, so the admin dashboard can
	// report that the Stripe → cloud integration is live.
	setMeta(r.Context(), b.db, b.dialect, "last_webhook_at", time.Now().UTC().Format(timeFormat))
	w.WriteHeader(http.StatusOK)
}

// defaultPaidPlan returns the id + Stripe price of the first active paid plan (there is
// one today, 'default'). Empty strings when none is configured.
func (b *billing) defaultPaidPlan(ctx context.Context) (planID, priceID string) {
	var id, price sql.NullString
	_ = b.db.QueryRowContext(ctx, b.rebind(
		`SELECT id, stripe_price_id FROM subscription_plans
		 WHERE stripe_price_id IS NOT NULL AND active = 1 ORDER BY id LIMIT 1;`)).Scan(&id, &price)
	return id.String, price.String
}

// applyCheckoutSession records the subscription linkage carried by a completed Checkout
// session at the given status. Shared by the synchronous completion and the deferred
// async-payment-succeeded events. A session with no client_reference_id can't be tied to an
// account, so it is a no-op (the webhook still acks 200).
func (b *billing) applyCheckoutSession(ctx context.Context, cs *stripe.CheckoutSession, status string) {
	if cs.ClientReferenceID == "" {
		return
	}
	var customerID, subID string
	if cs.Customer != nil {
		customerID = cs.Customer.ID
	}
	if cs.Subscription != nil {
		subID = cs.Subscription.ID
	}
	planID := cs.Metadata["plan_id"]
	if planID == "" {
		planID = "default"
	}
	b.upsertByUser(ctx, cs.ClientReferenceID, planID, customerID, subID, status, "")
}

// upsertByUser records or refreshes a Stripe-sourced subscription after checkout. Keyed by
// user_id so a repeat checkout replaces the prior linkage.
func (b *billing) upsertByUser(ctx context.Context, userID, planID, customerID, subID, status, periodEnd string) {
	now := time.Now().UTC().Format(timeFormat)
	_, err := b.db.ExecContext(ctx, b.rebind(`
		INSERT INTO subscriptions (user_id, plan_id, source, stripe_customer_id, stripe_subscription_id, status, current_period_end, created_at, updated_at)
		VALUES (?, ?, 'stripe', ?, ?, ?, ?, ?, ?)
		ON CONFLICT (user_id) DO UPDATE SET
		  plan_id = excluded.plan_id,
		  source = 'stripe',
		  stripe_customer_id = excluded.stripe_customer_id,
		  stripe_subscription_id = excluded.stripe_subscription_id,
		  status = excluded.status,
		  updated_at = excluded.updated_at;`),
		userID, nullify(planID), nullify(customerID), nullify(subID), status, nullify(periodEnd), now, now)
	if err != nil {
		slog.Error("billing: upsert subscription", "user", userID, "err", err)
	}
}

// updateByCustomer applies a subscription lifecycle change from a customer.subscription.*
// event. It matches on the exact Stripe subscription id first: a customer may have owned
// several subscriptions over time (e.g. a re-checkout), and a lifecycle event for an *old*
// one must not overwrite the row that tracks the current subscription — otherwise canceling
// a superseded subscription would lock a paying user out of sync. Only when no row tracks
// that subscription id yet does it fall back to the customer, and even then it won't adopt
// the event over a row already bound to a different subscription.
func (b *billing) updateByCustomer(ctx context.Context, customerID, subID, status, periodEnd string) {
	if subID == "" && customerID == "" {
		return
	}
	now := time.Now().UTC().Format(timeFormat)
	if subID != "" {
		res, err := b.db.ExecContext(ctx, b.rebind(`
			UPDATE subscriptions
			SET status = ?, current_period_end = ?, updated_at = ?
			WHERE stripe_subscription_id = ?;`),
			status, nullify(periodEnd), now, subID)
		if err != nil {
			slog.Error("billing: update subscription", "subscription", subID, "err", err)
			return
		}
		if n, _ := res.RowsAffected(); n > 0 {
			return
		}
	}
	if customerID == "" {
		return
	}
	// First lifecycle event after checkout, before the subscription id was recorded: bind it
	// to the customer's row, but never clobber a row already tracking a different subscription.
	_, err := b.db.ExecContext(ctx, b.rebind(`
		UPDATE subscriptions
		SET stripe_subscription_id = ?, status = ?, current_period_end = ?, updated_at = ?
		WHERE stripe_customer_id = ? AND (stripe_subscription_id IS NULL OR stripe_subscription_id = ?);`),
		nullify(subID), status, nullify(periodEnd), now, customerID, subID)
	if err != nil {
		slog.Error("billing: update subscription", "customer", customerID, "err", err)
	}
}

// nullify maps an empty string to a SQL NULL so optional columns stay NULL rather than "".
func nullify(s string) any {
	if s == "" {
		return nil
	}
	return s
}
