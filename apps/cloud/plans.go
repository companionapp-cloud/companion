package main

import (
	"net/http"
	"strings"
	"time"

	stripe "github.com/stripe/stripe-go/v81"
	"github.com/stripe/stripe-go/v81/price"
)

// Subscription-plan management for admins. Paid plans are not seeded — an admin queries
// their Stripe prices and creates a plan from one (the 'free' plan is the only seeded
// plan). A plan maps our slug to a Stripe Price id; the checkout flow bills through it.

type adminPlan struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	StripePriceID string `json:"stripePriceId"`
	Amount        int64  `json:"amount"`
	Currency      string `json:"currency"`
	Interval      string `json:"interval"`
	Active        bool   `json:"active"`
}

// handlePlans lists every configured plan (free first, then by name).
func (a *admin) handlePlans(w http.ResponseWriter, r *http.Request) {
	rows, err := a.db.QueryContext(r.Context(), a.rebind(`
		SELECT id, name, COALESCE(stripe_price_id, ''), COALESCE(amount, 0),
		       currency, COALESCE(interval, ''), active
		FROM subscription_plans
		ORDER BY CASE WHEN id = 'free' THEN 0 ELSE 1 END, name;`))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "plans query failed")
		return
	}
	defer rows.Close()
	out := []adminPlan{}
	for rows.Next() {
		var p adminPlan
		var active int64
		if err := rows.Scan(&p.ID, &p.Name, &p.StripePriceID, &p.Amount, &p.Currency, &p.Interval, &active); err != nil {
			writeErr(w, http.StatusInternalServerError, "scan failed")
			return
		}
		p.Active = active == 1
		out = append(out, p)
	}
	writeJSON(w, http.StatusOK, map[string]any{"plans": out})
}

// stripePrice is a Stripe recurring price offered as the basis for a new plan.
type stripePrice struct {
	PriceID     string `json:"priceId"`
	ProductName string `json:"productName"`
	Nickname    string `json:"nickname"`
	Amount      int64  `json:"amount"`
	Currency    string `json:"currency"`
	Interval    string `json:"interval"`
}

// handleStripePrices lists the account's active recurring Stripe prices (with product
// names) so an admin can pick one when creating a plan.
func (a *admin) handleStripePrices(w http.ResponseWriter, r *http.Request) {
	if stripe.Key == "" {
		writeErr(w, http.StatusServiceUnavailable, "Stripe is not configured")
		return
	}
	params := &stripe.PriceListParams{
		Active: stripe.Bool(true),
		Type:   stripe.String(string(stripe.PriceTypeRecurring)),
	}
	params.Limit = stripe.Int64(100)
	params.AddExpand("data.product")

	out := []stripePrice{}
	it := price.List(params)
	for it.Next() {
		p := it.Price()
		sp := stripePrice{
			PriceID:  p.ID,
			Nickname: p.Nickname,
			Amount:   p.UnitAmount,
			Currency: string(p.Currency),
		}
		if p.Product != nil {
			sp.ProductName = p.Product.Name
		}
		if p.Recurring != nil {
			sp.Interval = string(p.Recurring.Interval)
		}
		out = append(out, sp)
	}
	if err := it.Err(); err != nil {
		writeErr(w, http.StatusBadGateway, "could not load Stripe prices")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"prices": out})
}

type createPlanRequest struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	StripePriceID string `json:"stripePriceId"`
	Amount        int64  `json:"amount"`
	Currency      string `json:"currency"`
	Interval      string `json:"interval"`
}

// handleCreatePlan adds a plan mapped to a Stripe price. The slug and Stripe price are
// required; amount/currency/interval are carried from the chosen price for display.
func (a *admin) handleCreatePlan(w http.ResponseWriter, r *http.Request) {
	var req createPlanRequest
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	id := strings.TrimSpace(req.ID)
	if id == "" || req.StripePriceID == "" {
		writeErr(w, http.StatusBadRequest, "id and stripePriceId are required")
		return
	}
	if id == "free" {
		writeErr(w, http.StatusConflict, "'free' is reserved")
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = id
	}
	currency := req.Currency
	if currency == "" {
		currency = "usd"
	}
	now := time.Now().UTC().Format(timeFormat)
	if _, err := a.db.ExecContext(r.Context(), a.rebind(`
		INSERT INTO subscription_plans (id, name, stripe_price_id, amount, currency, interval, active, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
		ON CONFLICT (id) DO UPDATE SET name = excluded.name, stripe_price_id = excluded.stripe_price_id,
		  amount = excluded.amount, currency = excluded.currency, interval = excluded.interval,
		  active = 1, updated_at = excluded.updated_at;`),
		id, name, req.StripePriceID, req.Amount, currency, nullify(req.Interval), now, now); err != nil {
		writeErr(w, http.StatusInternalServerError, "create failed")
		return
	}
	a.handlePlans(w, r)
}

// handleDeletePlan removes a plan. The built-in 'free' plan can't be deleted.
func (a *admin) handleDeletePlan(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "free" {
		writeErr(w, http.StatusConflict, "the free plan can't be deleted")
		return
	}
	if _, err := a.db.ExecContext(r.Context(), a.rebind(`DELETE FROM subscription_plans WHERE id = ?;`), id); err != nil {
		writeErr(w, http.StatusInternalServerError, "delete failed")
		return
	}
	a.handlePlans(w, r)
}
