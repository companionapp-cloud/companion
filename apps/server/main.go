// Command server is the Companion sync API: auth + push/pull, reusing core/domain
// entities and core/sync/protocol wire types (PLAN §5). It persists to its own store
// (SQLite here; Postgres in production) and never touches the client sqlite store or
// client sync engine.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
)

func main() {
	// Prefer Postgres via DATABASE_URL (production); fall back to SQLite for
	// zero-config local dev (COMPANION_DB, default file).
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("COMPANION_DB")
		if dsn == "" {
			dsn = "companion-server.db"
		}
	}
	db, dialect, err := openDB(dsn)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()

	addr := os.Getenv("COMPANION_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	srv := NewServer(db, dialect)
	// Hourly Trash collector: promotes expired trashed rows to tombstones (PLAN §7.6).
	srv.StartTrashCollector(context.Background())

	log.Printf("companion server listening on %s (store=%s)", addr, dialect)
	if err := http.ListenAndServe(addr, srv.Handler()); err != nil {
		log.Fatalf("serve: %v", err)
	}
}
