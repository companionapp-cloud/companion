// Command server is the open-core Companion sync API: auth + push/pull, reusing the
// shared companion/syncserver library (PLAN §5). It persists to its own store (SQLite
// here; Postgres in production) and never touches the client sqlite store or client sync
// engine. The cloud binary wraps the same library with billing/subscription authorization.
package main

import (
	"context"
	"net/http"
	"os"

	"companion/syncserver"
)

func main() {
	logger := syncserver.SetupLogging()

	// Prefer Postgres via DATABASE_URL (production); fall back to SQLite for
	// zero-config local dev (COMPANION_DB, default file).
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("COMPANION_DB")
		if dsn == "" {
			dsn = "companion-server.db"
		}
	}
	db, dialect, err := syncserver.OpenDB(dsn)
	if err != nil {
		logger.Error("open db", "err", err)
		os.Exit(1)
	}
	defer db.Close()

	addr := os.Getenv("COMPANION_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	srv := syncserver.New(db, dialect)
	// Hourly Trash collector: promotes expired trashed rows to tombstones (PLAN §7.6).
	srv.StartTrashCollector(context.Background())
	// Per-minute repeat-task generator: creates each seed's occurrence just in time, only
	// once its due instant has arrived (never ahead); seed writes also check on push (PLAN §6.4).
	srv.StartRepeatMaterializer(context.Background())
	// Periodic ICS fetcher: clones each feed's expanded events into calendar_events, which
	// clients pull read-only (PLAN §6.7).
	srv.StartCalendarFetcher(context.Background())

	logger.Info("companion server listening", "addr", addr, "store", dialect)
	if err := http.ListenAndServe(addr, syncserver.LogRequests(logger)(srv.Handler())); err != nil {
		logger.Error("serve", "err", err)
		os.Exit(1)
	}
}
