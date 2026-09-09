// Command cloud is the hosted Companion service: the open-core sync API (companion/
// syncserver, mounted 1:1 under /api/v1, including its email verification and password
// reset flows) wrapped with Stripe billing and a subscription gate, plus an embedded
// account/billing frontend served at "/". Users can register, but sync returns 403 until
// they hold an active subscription. All billing configuration is read from the environment
// at runtime.
package main

import (
	"context"
	"embed"
	"encoding/json"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"strings"

	"companion/syncserver"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	logger := syncserver.SetupLogging()

	// Same store resolution as the open-core server: Postgres via DATABASE_URL in
	// production, SQLite for zero-config local dev.
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("COMPANION_DB")
		if dsn == "" {
			dsn = "companion-cloud.db"
		}
	}
	db, dialect, err := syncserver.OpenDB(dsn)
	if err != nil {
		logger.Error("open db", "err", err)
		os.Exit(1)
	}
	defer db.Close()

	// Billing tables live alongside the sync data on the same store.
	if err := applyCloudSchema(db, dialect); err != nil {
		logger.Error("apply cloud schema", "err", err)
		os.Exit(1)
	}
	// Seed only the built-in free plan; paid plans are created by admins from Stripe.
	seedFreePlan(db, dialect)

	addr := os.Getenv("COMPANION_ADDR")
	if addr == "" {
		addr = ":8080"
	}

	bill := newBilling(db, dialect)
	// CLOUD_BASE_URL is the portal's origin: verification/reset emails link to its pages
	// (/verify, /reset) rather than syncserver's own landing pages, and the client-facing API
	// base (SYNC_API_URL) is what the reset hand-off tells the app to talk to.
	baseURL := strings.TrimRight(os.Getenv("CLOUD_BASE_URL"), "/")
	if baseURL == "" {
		baseURL = "http://localhost:8080"
	}
	// The subscription gate: syncserver calls Guard before every sync-gated request.
	// WithoutCORS: the cloud owns one CORS policy across its whole tree (API + billing +
	// frontend) rather than letting syncserver wrap only the /api routes.
	srv := syncserver.New(db, dialect,
		syncserver.WithSyncGuard(bill.Guard),
		syncserver.WithoutCORS(),
		syncserver.WithMailer(syncserver.NewMailerFromEnv()),
		syncserver.WithPublicURL(syncAPIURL(baseURL)),
		syncserver.WithAppURL(os.Getenv("CLOUD_APP_URL")),
		syncserver.WithEmailLinks(syncserver.EmailLinks{
			Verify: func(token string) string { return baseURL + "/verify?token=" + token },
			Reset:  func(token string) string { return baseURL + "/reset?token=" + token },
		}),
	)
	adm := newAdmin(db, dialect, bill, srv)
	srv.StartTrashCollector(context.Background())
	srv.StartRepeatMaterializer(context.Background())
	// Calendar ICS fetching moved to the client (PLAN §E2EE); no server-side fetch sweep.

	// CLOUD_ADMIN_EMAILS bootstraps the admin_users table: any already-registered user with
	// a listed email is promoted at boot (others must register first, then be re-promoted or
	// added via SQL).
	if v := strings.TrimSpace(os.Getenv("CLOUD_ADMIN_EMAILS")); v != "" {
		promoteAdmins(db, dialect, splitTrim(v))
	}

	// CLOUD_CORS_ORIGINS is a comma-separated allowlist ("*" = any origin). Defaults to
	// "*" to match the open-core server's dev-friendly behavior; lock it down in production.
	origins := []string{"*"}
	if v := strings.TrimSpace(os.Getenv("CLOUD_CORS_ORIGINS")); v != "" {
		origins = strings.Split(v, ",")
	}
	// Outermost: request logging wraps CORS + routing so every request (including preflight)
	// is logged once with its final status.
	root := syncserver.LogRequests(logger)(syncserver.CORS(origins)(handler(srv, bill, adm)))

	logger.Info("companion cloud listening", "addr", addr, "store", dialect, "cors", strings.Join(origins, ","))
	if err := http.ListenAndServe(addr, root); err != nil {
		logger.Error("serve", "err", err)
		os.Exit(1)
	}
}

// handler builds the cloud routing tree: cloud-only billing endpoints and the whole
// open-core sync API under /api/v1, with the embedded frontend at "/". The explicit
// billing patterns are more specific than the "/api/" mount, so Go 1.22's method-aware
// mux routes them first.
func handler(srv *syncserver.Server, bill *billing, adm *admin) http.Handler {
	mux := http.NewServeMux()

	// Public runtime config for the frontend. syncUrl is the base URL clients enter in the
	// Companion app's sync settings (see syncAPIURL).
	syncURL := syncAPIURL(strings.TrimRight(os.Getenv("CLOUD_BASE_URL"), "/"))
	// appUrl is where the portal sends users for actions only the app can do — notably changing an
	// encrypted account's password, which requires the crypto core to rewrap the master key (PLAN
	// §E2EE). CLOUD_APP_URL can be a hosted web-app URL or a custom-scheme deeplink
	// (e.g. companion://settings/security); empty disables the link and the portal shows guidance
	// text only.
	appURL := strings.TrimRight(os.Getenv("CLOUD_APP_URL"), "/")
	// PostHog analytics config for the frontend. These are injected at runtime (not baked
	// into the Vite build) so the same embedded assets work across environments. The
	// project token is a public client-side key; analytics stay disabled when it's unset.
	posthogToken := strings.TrimSpace(os.Getenv("POSTHOG_PROJECT_TOKEN"))
	posthogHost := strings.TrimSpace(os.Getenv("POSTHOG_HOST"))
	mux.HandleFunc("GET /api/v1/config", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{
			"syncUrl":             syncURL,
			"appUrl":              appURL,
			"posthogProjectToken": posthogToken,
			"posthogHost":         posthogHost,
		})
	})

	// Email verification and forgot-password live in syncserver now (shared with the
	// open-core server) and arrive through the /api mount below at /api/v1/auth/....

	// Billing (cloud-only). Checkout + status require a session; the webhook is
	// authenticated by its Stripe signature instead.
	mux.Handle("POST /api/v1/billing/checkout", srv.Authed(bill.handleCheckout))
	mux.Handle("GET /api/v1/billing/subscription", srv.Authed(bill.handleStatus))
	mux.Handle("GET /api/v1/billing/invoices", srv.Authed(bill.handleInvoices))
	mux.Handle("GET /api/v1/billing/upcoming", srv.Authed(bill.handleUpcoming))
	mux.HandleFunc("POST /api/v1/billing/webhook", bill.handleWebhook)

	// Admin back-office (cloud-only). Every route is a valid session + admin membership.
	admin := func(h http.HandlerFunc) http.Handler { return srv.Authed(adm.requireAdmin(h)) }
	mux.Handle("GET /api/v1/admin/me", admin(adm.handleMe))
	mux.Handle("GET /api/v1/admin/dashboard", admin(adm.handleDashboard))
	mux.Handle("GET /api/v1/admin/users", admin(adm.handleUsers))
	mux.Handle("GET /api/v1/admin/users/{id}", admin(adm.handleUser))
	mux.Handle("POST /api/v1/admin/users/{id}", admin(adm.handleUpdateUser))
	mux.Handle("GET /api/v1/admin/users/{id}/invoices", admin(adm.handleUserInvoices))
	mux.Handle("POST /api/v1/admin/users/{id}/grant-free", admin(adm.handleGrantFree))
	mux.Handle("POST /api/v1/admin/users/{id}/revoke", admin(adm.handleRevoke))
	mux.Handle("POST /api/v1/admin/users/{id}/resend-verification", admin(adm.handleResendVerification))
	mux.Handle("GET /api/v1/admin/subscriptions", admin(adm.handleSubscriptions))
	// Plan management: list local plans, browse Stripe prices, create + delete plans.
	mux.Handle("GET /api/v1/admin/plans", admin(adm.handlePlans))
	mux.Handle("POST /api/v1/admin/plans", admin(adm.handleCreatePlan))
	mux.Handle("DELETE /api/v1/admin/plans/{id}", admin(adm.handleDeletePlan))
	mux.Handle("GET /api/v1/admin/stripe/prices", admin(adm.handleStripePrices))

	// The open-core API, mounted 1:1 under /api. syncserver registers its routes at
	// /v1/...; stripping /api yields exactly those paths.
	mux.Handle("/api/", http.StripPrefix("/api", srv.Handler()))

	// The embedded account/billing frontend at the root.
	mux.Handle("/", spaHandler())
	return mux
}

// syncAPIURL is the base URL clients enter in the Companion app's sync settings; the client
// appends /v1/... so it must point at the API root (/api). Operators set SYNC_API_URL to
// the public URL; it defaults to CLOUD_BASE_URL + /api for local dev.
func syncAPIURL(baseURL string) string {
	if u := strings.TrimRight(os.Getenv("SYNC_API_URL"), "/"); u != "" {
		return u
	}
	if baseURL != "" {
		return baseURL + "/api"
	}
	return ""
}

// spaHandler serves the embedded Vite build, falling back to index.html for client-side
// routes (any non-file path) so deep links resolve to the SPA.
func spaHandler() http.Handler {
	dist, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		slog.Error("mount frontend assets", "err", err)
		os.Exit(1)
	}
	files := http.FileServer(http.FS(dist))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Serve real files directly; route everything else to index.html.
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p != "" {
			if _, err := fs.Stat(dist, p); err == nil {
				files.ServeHTTP(w, r)
				return
			}
		}
		r.URL.Path = "/"
		files.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func decodeJSON(r *http.Request, v any) error {
	return json.NewDecoder(r.Body).Decode(v)
}

// splitTrim splits a comma-separated list, trimming and dropping empties.
func splitTrim(s string) []string {
	out := []string{}
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
