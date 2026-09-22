package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"companion/syncserver"

	stripe "github.com/stripe/stripe-go/v81"
	"github.com/stripe/stripe-go/v81/subscription"
)

// Account deletion as billing sees it. syncserver runs the flow (account_deletion.go) and calls
// these hooks: while an account waits out its grace period its subscription must not renew, a
// sign-in that takes the deletion back must undo that, and the purge must end billing for good
// before the account's data goes, so nobody is charged for an account that no longer exists.

// subscriptionAPI is the slice of Stripe's subscription API the deletion hooks drive, a seam
// so tests can stand in for Stripe.
type subscriptionAPI interface {
	// Configured reports whether Stripe can be called at all (a secret key is set).
	Configured() bool
	Update(id string, params *stripe.SubscriptionParams) (*stripe.Subscription, error)
	Cancel(id string, params *stripe.SubscriptionCancelParams) (*stripe.Subscription, error)
}

// liveStripe is the production subscriptionAPI: stripe-go's package-level client.
type liveStripe struct{}

func (liveStripe) Configured() bool { return stripe.Key != "" }

func (liveStripe) Update(id string, params *stripe.SubscriptionParams) (*stripe.Subscription, error) {
	return subscription.Update(id, params)
}

func (liveStripe) Cancel(id string, params *stripe.SubscriptionCancelParams) (*stripe.Subscription, error) {
	return subscription.Cancel(id, params)
}

// stripeSubs returns the test double when one is set, else live Stripe.
func (b *billing) stripeSubs() subscriptionAPI {
	if b.subs != nil {
		return b.subs
	}
	return liveStripe{}
}

// accountLifecycle is billing's side of account deletion, for syncserver.WithAccountLifecycle.
func (b *billing) accountLifecycle() syncserver.AccountLifecycle {
	return syncserver.AccountLifecycle{
		DeletionRequested: b.pauseForDeletion,
		DeletionCancelled: b.resumeAfterDeletionCancelled,
		Purge:             b.purgeAccount,
	}
}

// pauseForDeletion stops a live Stripe subscription renewing while its account waits to be
// deleted, so the user isn't charged for a period they won't use, and records that the pause is
// ours (paused_for_deletion) so a sign-in that takes the deletion back can undo it. A
// subscription already set to end stays as the user left it, and an admin grant has nothing to
// stop. Failures are only logged: the purge cancels the subscription outright either way.
func (b *billing) pauseForDeletion(ctx context.Context, userID string, _ time.Time) {
	st, err := b.state(ctx, userID)
	if err != nil {
		slog.Error("billing: pause for deletion: status lookup", "user", userID, "err", err)
		return
	}
	if !st.Cancelable || st.CancelAtPeriodEnd {
		return
	}
	if err := b.updateCancelAtPeriodEnd(ctx, st.subID, true); err != nil {
		slog.Error("billing: pause for deletion", "user", userID, "subscription", st.subID, "err", err)
		return
	}
	b.markPausedForDeletion(ctx, userID, true)
}

// resumeAfterDeletionCancelled turns renewal back on for a subscription that pauseForDeletion
// paused, once a sign-in has taken the deletion back. A subscription that is no longer live
// (its period ran out during the grace period) has nothing to resume, so only the flag is
// cleared. If Stripe refuses, the flag stays for the next reactivation to retry.
func (b *billing) resumeAfterDeletionCancelled(ctx context.Context, userID string) {
	st, err := b.state(ctx, userID)
	if err != nil {
		slog.Error("billing: resume after deletion cancelled: status lookup", "user", userID, "err", err)
		return
	}
	if !st.pausedForDeletion {
		return // no pause of ours: a cancellation the user scheduled stays theirs
	}
	if st.Cancelable && st.CancelAtPeriodEnd {
		if err := b.updateCancelAtPeriodEnd(ctx, st.subID, false); err != nil {
			slog.Error("billing: resume after deletion cancelled", "user", userID, "subscription", st.subID, "err", err)
			return
		}
	}
	b.markPausedForDeletion(ctx, userID, false)
}

// purgeAccount ends billing for an account about to be erased, then deletes its cloud rows (the
// subscription and any admin membership). A Stripe subscription that could still charge is
// cancelled immediately; pausing renewal is not enough once the data is gone. When Stripe isn't
// configured or refuses, it returns an error and syncserver keeps the account until the next
// sweep, so an account is never erased while it can still be billed. Once the rows are gone a
// rerun has nothing left to do, which makes it idempotent as syncserver requires.
func (b *billing) purgeAccount(ctx context.Context, userID string) error {
	st, err := b.state(ctx, userID)
	if err != nil {
		return err
	}
	if st.source == "stripe" && st.subID != "" && stillBillable(st.Status) {
		if err := b.cancelNow(ctx, st.subID); err != nil {
			return fmt.Errorf("cancel stripe subscription %s: %w", st.subID, err)
		}
	}
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, b.rebind(`DELETE FROM subscriptions WHERE user_id = ?;`), userID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, b.rebind(`DELETE FROM admin_users WHERE user_id = ?;`), userID); err != nil {
		return err
	}
	return tx.Commit()
}

// stillBillable reports whether a subscription in this status could still charge the customer:
// anything but a finished one (canceled, incomplete_expired) or none at all.
func stillBillable(status string) bool {
	switch stripe.SubscriptionStatus(status) {
	case stripe.SubscriptionStatusCanceled, stripe.SubscriptionStatusIncompleteExpired, "none", "":
		return false
	}
	return true
}

// updateCancelAtPeriodEnd sets Stripe's cancel_at_period_end on a subscription and mirrors
// Stripe's answer onto the local row. A mirror failure is only logged: Stripe has the change,
// and the next webhook repairs the row.
func (b *billing) updateCancelAtPeriodEnd(ctx context.Context, subID string, cancel bool) error {
	api := b.stripeSubs()
	if !api.Configured() {
		return errors.New("billing is not configured")
	}
	params := &stripe.SubscriptionParams{CancelAtPeriodEnd: stripe.Bool(cancel)}
	params.Context = ctx
	sub, err := api.Update(subID, params)
	if err != nil {
		return err
	}
	if _, err := b.applySubscription(ctx, subID, string(sub.Status), periodEndOf(sub), sub.CancelAtPeriodEnd); err != nil {
		slog.Error("billing: mirror subscription", "subscription", subID, "err", err)
	}
	return nil
}

// cancelNow cancels a Stripe subscription immediately. One Stripe no longer has counts as
// cancelled: there is nothing left to bill.
func (b *billing) cancelNow(ctx context.Context, subID string) error {
	api := b.stripeSubs()
	if !api.Configured() {
		return errors.New("billing is not configured")
	}
	params := &stripe.SubscriptionCancelParams{}
	params.Context = ctx
	_, err := api.Cancel(subID, params)
	var serr *stripe.Error
	if errors.As(err, &serr) && serr.Code == stripe.ErrorCodeResourceMissing {
		return nil
	}
	return err
}

// markPausedForDeletion records whether renewal is off only because of a pending deletion.
func (b *billing) markPausedForDeletion(ctx context.Context, userID string, paused bool) {
	if _, err := b.db.ExecContext(ctx, b.rebind(
		`UPDATE subscriptions SET paused_for_deletion = ?, updated_at = ? WHERE user_id = ?;`),
		boolInt(paused), time.Now().UTC().Format(timeFormat), userID); err != nil {
		slog.Error("billing: record deletion pause", "user", userID, "paused", paused, "err", err)
	}
}

// periodEndOf is a subscription's current period end as stored text, or "" when Stripe sent
// none (applySubscription then keeps the date already on file).
func periodEndOf(sub *stripe.Subscription) string {
	if sub.CurrentPeriodEnd <= 0 {
		return ""
	}
	return time.Unix(sub.CurrentPeriodEnd, 0).UTC().Format(timeFormat)
}
