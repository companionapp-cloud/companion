package main

import (
	"context"
	"database/sql"
	"log/slog"
	"strconv"
	"strings"
	"time"
)

// cloudSchema adds the billing tables the open-core server has no concept of. It lives
// on the same store as the sync data (one database), so a subscription check is a cheap
// local read. Column types (TEXT) are valid on both SQLite (dev) and Postgres (prod),
// matching syncserver's own schema conventions.
const cloudSchema = `
-- Catalog of offered plans. Each maps to at most one Stripe price (NULL = free/comp).
-- Adding a price point later is a new row; nothing else changes.
CREATE TABLE IF NOT EXISTS subscription_plans (
  id              TEXT PRIMARY KEY,           -- slug: 'free', 'default', 'pro-yearly', …
  name            TEXT NOT NULL,
  stripe_price_id TEXT,                       -- NULL for free/comp plans
  amount          BIGINT,                     -- minor units, informational
  currency        TEXT NOT NULL DEFAULT 'usd',
  interval        TEXT,                       -- 'month' | 'year' | NULL
  active          BIGINT NOT NULL DEFAULT 1,  -- offered for self-serve checkout?
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  user_id                TEXT PRIMARY KEY,
  plan_id                TEXT,                       -- references subscription_plans.id
  source                 TEXT NOT NULL DEFAULT 'stripe', -- 'stripe' | 'admin'
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  status                 TEXT NOT NULL DEFAULT 'none',
  current_period_end     TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions (stripe_customer_id);

-- Admins are ordinary users (in syncserver's users table) also present here. Membership is
-- managed out of band (SQL, or the CLOUD_ADMIN_EMAILS bootstrap), never self-serve.
CREATE TABLE IF NOT EXISTS admin_users (
  user_id    TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- Small key/value store for cloud-level operational state (e.g. last webhook received).
CREATE TABLE IF NOT EXISTS cloud_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One-time email verification tokens. The email is captured at issue time so a later
-- address change invalidates in-flight tokens (they'd verify a stale address).
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  email      TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_verification_user ON email_verification_tokens (user_id);
`

// applyCloudSchema creates the billing + admin tables and retrofits new columns onto
// pre-existing dev DBs. It runs after syncserver.OpenDB applied the sync schema.
func applyCloudSchema(db *sql.DB, dialect string) error {
	if _, err := db.Exec(cloudSchema); err != nil {
		return err
	}
	// Column additions a plain CREATE IF NOT EXISTS can't retrofit (plans refactor).
	alters := []string{
		`ALTER TABLE subscriptions ADD COLUMN plan_id TEXT`,
		`ALTER TABLE subscriptions ADD COLUMN source TEXT NOT NULL DEFAULT 'stripe'`,
	}
	for _, a := range alters {
		if dialect == "postgres" {
			a = strings.Replace(a, "ADD COLUMN", "ADD COLUMN IF NOT EXISTS", 1)
		}
		if _, err := db.Exec(a); err != nil && !strings.Contains(err.Error(), "duplicate column") {
			return err
		}
	}
	return nil
}

// seedFreePlan ensures the built-in perpetual 'free' plan exists (no Stripe price). It is
// the only seeded plan — paid plans are created by admins from their Stripe prices (see
// plans.go). Idempotent, safe to run every boot.
func seedFreePlan(db *sql.DB, dialect string) {
	now := time.Now().UTC().Format(timeFormat)
	if _, err := db.Exec(rebind(dialect, `
		INSERT INTO subscription_plans (id, name, currency, active, created_at, updated_at)
		VALUES ('free', 'Free', 'usd', 1, ?, ?)
		ON CONFLICT (id) DO NOTHING;`), now, now); err != nil {
		slog.Error("seed free plan", "err", err)
	}
}

// setMeta upserts a cloud_meta key.
func setMeta(ctx context.Context, db *sql.DB, dialect, key, value string) {
	_, err := db.ExecContext(ctx, rebind(dialect,
		`INSERT INTO cloud_meta (key, value) VALUES (?, ?)
		 ON CONFLICT (key) DO UPDATE SET value = excluded.value;`), key, value)
	if err != nil {
		slog.Error("cloud_meta set", "key", key, "err", err)
	}
}

// getMeta reads a cloud_meta key, returning "" when absent.
func getMeta(ctx context.Context, db *sql.DB, dialect, key string) string {
	var v string
	_ = db.QueryRowContext(ctx, rebind(dialect, `SELECT value FROM cloud_meta WHERE key = ?;`), key).Scan(&v)
	return v
}

// rebind converts '?' placeholders to Postgres' positional '$N' form (no-op on SQLite),
// mirroring syncserver's rebind so the billing queries run on either dialect.
func rebind(dialect, query string) string {
	if dialect != "postgres" {
		return query
	}
	var b strings.Builder
	n := 0
	for i := 0; i < len(query); i++ {
		if query[i] == '?' {
			n++
			b.WriteByte('$')
			b.WriteString(strconv.Itoa(n))
			continue
		}
		b.WriteByte(query[i])
	}
	return b.String()
}
