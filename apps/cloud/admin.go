package main

import (
	"database/sql"
	"net/http"
	"strings"
	"time"

	"companion/syncserver"

	stripe "github.com/stripe/stripe-go/v81"
	"github.com/stripe/stripe-go/v81/balance"
)

// admin is the cloud's back-office API (dashboard, users, subscriptions). Every route is
// gated by requireAdmin on top of a valid session, so only users listed in admin_users
// reach it. It shares the store with syncserver + billing.
type admin struct {
	db      *sql.DB
	dialect string
	bill    *billing
	vrf     *verifier
}

func newAdmin(db *sql.DB, dialect string, bill *billing, vrf *verifier) *admin {
	return &admin{db: db, dialect: dialect, bill: bill, vrf: vrf}
}

func (a *admin) rebind(q string) string { return rebind(a.dialect, q) }

// isAdmin reports whether a user id is in admin_users.
func (a *admin) isAdmin(uid string) bool {
	var one int
	err := a.db.QueryRow(a.rebind(`SELECT 1 FROM admin_users WHERE user_id = ?;`), uid).Scan(&one)
	return err == nil
}

// requireAdmin wraps a handler so only admins reach it; everyone else gets 404 (so the
// admin surface isn't even acknowledged to non-admins). Assumes syncserver.Authed ran
// first to populate the user id.
func (a *admin) requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !a.isAdmin(syncserver.UserID(r)) {
			writeErr(w, http.StatusNotFound, "not found")
			return
		}
		next(w, r)
	}
}

// handleMe confirms the caller is an admin (reachable only through requireAdmin). The
// frontend calls it to decide whether to reveal the admin area.
func (a *admin) handleMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"admin": true})
}

// ---- dashboard ------------------------------------------------------------

func (a *admin) handleDashboard(w http.ResponseWriter, r *http.Request) {
	now := time.Now().UTC()
	// Rolling windows: today = since UTC midnight, week = last 7d, month = last 30d.
	midnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	windows := map[string]string{
		"today": midnight.Format(timeFormat),
		"week":  now.AddDate(0, 0, -7).Format(timeFormat),
		"month": now.AddDate(0, 0, -30).Format(timeFormat),
		"all":   "",
	}

	users := a.counts(r, `SELECT COUNT(*) FROM users`, ``, windows)
	subs := a.counts(r, `SELECT COUNT(*) FROM subscriptions`, `status IN ('active','trialing')`, windows)

	writeJSON(w, http.StatusOK, map[string]any{
		"users":         users,
		"subscriptions": subs,
		"stripe":        a.stripeStatus(r),
	})
}

// counts runs the base COUNT query for each period window, optionally AND-ed with an extra
// predicate. An empty window threshold means "all time".
func (a *admin) counts(r *http.Request, base, extra string, windows map[string]string) map[string]int64 {
	out := map[string]int64{}
	for period, since := range windows {
		q := base
		clauses := []string{}
		args := []any{}
		if extra != "" {
			clauses = append(clauses, extra)
		}
		if since != "" {
			clauses = append(clauses, "created_at >= ?")
			args = append(args, since)
		}
		for i, c := range clauses {
			if i == 0 {
				q += " WHERE " + c
			} else {
				q += " AND " + c
			}
		}
		var n int64
		_ = a.db.QueryRowContext(r.Context(), a.rebind(q), args...).Scan(&n)
		out[period] = n
	}
	return out
}

// stripeStatus reports whether the Stripe integration is live: the secret key reaches the
// API, and a signed webhook has been received.
func (a *admin) stripeStatus(r *http.Request) map[string]any {
	apiConfigured := stripe.Key != ""
	apiReachable := false
	if apiConfigured {
		_, err := balance.Get(&stripe.BalanceParams{})
		apiReachable = err == nil
	}
	return map[string]any{
		"apiKeyConfigured":  apiConfigured,
		"apiReachable":      apiReachable,
		"webhookConfigured": a.bill.webhookSecret != "",
		"lastWebhookAt":     getMeta(r.Context(), a.db, a.dialect, "last_webhook_at"),
	}
}

// ---- users ----------------------------------------------------------------

type adminUser struct {
	ID                 string `json:"id"`
	Email              string `json:"email"`
	FirstName          string `json:"firstName"`
	LastName           string `json:"lastName"`
	CreatedAt          string `json:"createdAt"`
	IsAdmin            bool   `json:"isAdmin"`
	EmailVerified      bool   `json:"emailVerified"`
	SubscriptionStatus string `json:"subscriptionStatus"`
}

func (a *admin) handleUsers(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.QueryContext(r.Context(), a.rebind(`
		SELECT u.id, u.email, u.first_name, u.last_name, u.created_at,
		       CASE WHEN a.user_id IS NULL THEN 0 ELSE 1 END AS is_admin,
		       CASE WHEN u.email_verified_at IS NULL THEN 0 ELSE 1 END AS verified,
		       COALESCE(s.status, 'none') AS sub_status
		FROM users u
		LEFT JOIN admin_users a ON a.user_id = u.id
		LEFT JOIN subscriptions s ON s.user_id = u.id
		ORDER BY u.created_at DESC;`))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "users query failed")
		return
	}
	defer rows.Close()
	out := []adminUser{}
	for rows.Next() {
		var u adminUser
		var isAdmin, verified int
		if err := rows.Scan(&u.ID, &u.Email, &u.FirstName, &u.LastName, &u.CreatedAt, &isAdmin, &verified, &u.SubscriptionStatus); err != nil {
			writeErr(w, http.StatusInternalServerError, "scan failed")
			return
		}
		u.IsAdmin = isAdmin == 1
		u.EmailVerified = verified == 1
		out = append(out, u)
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": out})
}

// handleUser returns one user with their subscription detail.
func (a *admin) handleUser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var u adminUser
	var verifiedAt sql.NullString
	err := a.db.QueryRowContext(r.Context(), a.rebind(
		`SELECT id, email, first_name, last_name, created_at, email_verified_at FROM users WHERE id = ?;`), id).
		Scan(&u.ID, &u.Email, &u.FirstName, &u.LastName, &u.CreatedAt, &verifiedAt)
	if err == sql.ErrNoRows {
		writeErr(w, http.StatusNotFound, "user not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "user query failed")
		return
	}
	u.IsAdmin = a.isAdmin(id)
	u.EmailVerified = verifiedAt.Valid

	sub := a.subscriptionFor(r, id)
	writeJSON(w, http.StatusOK, map[string]any{"user": u, "subscription": sub})
}

type adminUpdateUser struct {
	Email     *string `json:"email"`
	FirstName *string `json:"firstName"`
	LastName  *string `json:"lastName"`
	IsAdmin   *bool   `json:"isAdmin"`
}

// handleUpdateUser edits a user's profile/email and (optionally) admin membership.
func (a *admin) handleUpdateUser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req adminUpdateUser
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	if req.Email != nil {
		email := strings.TrimSpace(strings.ToLower(*req.Email))
		if email == "" || !strings.Contains(email, "@") {
			writeErr(w, http.StatusBadRequest, "a valid email is required")
			return
		}
		// Same rule as self-service (account.go): a changed address is no longer verified.
		if _, err := a.db.ExecContext(r.Context(), a.rebind(`UPDATE users SET email = ?, email_verified_at = NULL WHERE id = ?;`), email, id); err != nil {
			writeErr(w, http.StatusConflict, "email already in use")
			return
		}
	}
	if req.FirstName != nil || req.LastName != nil {
		// Update whichever names were provided; missing ones keep their current value.
		if _, err := a.db.ExecContext(r.Context(), a.rebind(
			`UPDATE users SET first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name) WHERE id = ?;`),
			req.FirstName, req.LastName, id); err != nil {
			writeErr(w, http.StatusInternalServerError, "update failed")
			return
		}
	}
	if req.IsAdmin != nil {
		if *req.IsAdmin {
			a.db.ExecContext(r.Context(), a.rebind(
				`INSERT INTO admin_users (user_id, created_at) VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING;`),
				id, time.Now().UTC().Format(timeFormat))
		} else {
			a.db.ExecContext(r.Context(), a.rebind(`DELETE FROM admin_users WHERE user_id = ?;`), id)
		}
	}
	a.handleUser(w, r)
}

// ---- subscriptions --------------------------------------------------------

type adminSubscription struct {
	UserID           string `json:"userId"`
	Email            string `json:"email"`
	Plan             string `json:"plan"`
	Source           string `json:"source"`
	Status           string `json:"status"`
	CurrentPeriodEnd string `json:"currentPeriodEnd"`
	StripeCustomer   string `json:"stripeCustomerId"`
	StripeSub        string `json:"stripeSubscriptionId"`
	CreatedAt        string `json:"createdAt"`
}

func (a *admin) subscriptionFor(r *http.Request, userID string) *adminSubscription {
	var s adminSubscription
	var cust, sub, pend, plan sql.NullString
	err := a.db.QueryRowContext(r.Context(), a.rebind(`
		SELECT u.email, s.plan_id, s.source, s.status, s.current_period_end, s.stripe_customer_id, s.stripe_subscription_id, s.created_at
		FROM subscriptions s JOIN users u ON u.id = s.user_id
		WHERE s.user_id = ?;`), userID).
		Scan(&s.Email, &plan, &s.Source, &s.Status, &pend, &cust, &sub, &s.CreatedAt)
	if err != nil {
		return nil
	}
	s.UserID = userID
	s.Plan, s.CurrentPeriodEnd, s.StripeCustomer, s.StripeSub = plan.String, pend.String, cust.String, sub.String
	return &s
}

func (a *admin) handleSubscriptions(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.QueryContext(r.Context(), a.rebind(`
		SELECT s.user_id, u.email, s.plan_id, s.source, s.status, s.current_period_end,
		       s.stripe_customer_id, s.stripe_subscription_id, s.created_at
		FROM subscriptions s JOIN users u ON u.id = s.user_id
		ORDER BY s.created_at DESC;`))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "subscriptions query failed")
		return
	}
	defer rows.Close()
	out := []adminSubscription{}
	for rows.Next() {
		var s adminSubscription
		var cust, sub, pend, plan sql.NullString
		if err := rows.Scan(&s.UserID, &s.Email, &plan, &s.Source, &s.Status, &pend, &cust, &sub, &s.CreatedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "scan failed")
			return
		}
		s.Plan, s.CurrentPeriodEnd, s.StripeCustomer, s.StripeSub = plan.String, pend.String, cust.String, sub.String
		out = append(out, s)
	}
	writeJSON(w, http.StatusOK, map[string]any{"subscriptions": out})
}

// handleGrantFree gives a user a perpetual free subscription (plan 'free', source
// 'admin'). It refuses to clobber an active Stripe subscription — cancel that in Stripe
// first. The free grant has no Stripe ids and no end date; the sync guard already treats
// 'active' as entitled, so this immediately unlocks sync.
func (a *admin) handleGrantFree(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var status, source sql.NullString
	_ = a.db.QueryRowContext(r.Context(), a.rebind(
		`SELECT status, source FROM subscriptions WHERE user_id = ?;`), id).Scan(&status, &source)
	if source.String == "stripe" && (status.String == "active" || status.String == "trialing") {
		writeErr(w, http.StatusConflict, "user has an active Stripe subscription; cancel it in Stripe first")
		return
	}
	now := time.Now().UTC().Format(timeFormat)
	if _, err := a.db.ExecContext(r.Context(), a.rebind(`
		INSERT INTO subscriptions (user_id, plan_id, source, status, current_period_end, created_at, updated_at)
		VALUES (?, 'free', 'admin', 'active', NULL, ?, ?)
		ON CONFLICT (user_id) DO UPDATE SET
		  plan_id = 'free', source = 'admin', status = 'active',
		  stripe_customer_id = NULL, stripe_subscription_id = NULL,
		  current_period_end = NULL, updated_at = excluded.updated_at;`),
		id, now, now); err != nil {
		writeErr(w, http.StatusInternalServerError, "grant failed")
		return
	}
	a.handleUser(w, r)
}

// handleRevoke cancels an admin-granted free subscription. It won't touch a Stripe
// subscription (that must be canceled in Stripe so billing stays in sync).
func (a *admin) handleRevoke(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var source sql.NullString
	err := a.db.QueryRowContext(r.Context(), a.rebind(
		`SELECT source FROM subscriptions WHERE user_id = ?;`), id).Scan(&source)
	if err == sql.ErrNoRows {
		writeErr(w, http.StatusNotFound, "no subscription")
		return
	}
	if source.String != "admin" {
		writeErr(w, http.StatusConflict, "not an admin grant; cancel Stripe subscriptions in Stripe")
		return
	}
	now := time.Now().UTC().Format(timeFormat)
	if _, err := a.db.ExecContext(r.Context(), a.rebind(
		`UPDATE subscriptions SET status = 'canceled', updated_at = ? WHERE user_id = ?;`), now, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "revoke failed")
		return
	}
	a.handleUser(w, r)
}

// handleResendVerification re-issues + emails a verification link for a user.
func (a *admin) handleResendVerification(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	already, err := a.vrf.sendVerification(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "could not send verification email")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"verified": already, "sent": !already})
}

// handleUserInvoices lists a user's Stripe invoices (reuses the billing helper).
func (a *admin) handleUserInvoices(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	customerID, _ := a.bill.stripeIDs(r.Context(), id)
	out, err := a.bill.invoicesFor(customerID)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "could not load invoices")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"invoices": out})
}

// promoteAdmins ensures every existing user whose email is listed is in admin_users. It's
// the boot-time bootstrap for CLOUD_ADMIN_EMAILS so the first admin can be created without
// hand-writing SQL; users who haven't registered yet are simply skipped.
func promoteAdmins(db *sql.DB, dialect string, emails []string) {
	now := time.Now().UTC().Format(timeFormat)
	for _, email := range emails {
		var uid string
		if err := db.QueryRow(rebind(dialect, `SELECT id FROM users WHERE email = ?;`), email).Scan(&uid); err != nil {
			continue
		}
		db.Exec(rebind(dialect,
			`INSERT INTO admin_users (user_id, created_at) VALUES (?, ?) ON CONFLICT (user_id) DO NOTHING;`),
			uid, now)
	}
}
