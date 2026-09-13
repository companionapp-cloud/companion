package store

// Driver is the minimal SQL surface the store depends on, so the same repositories
// and migrations run on every platform (PLAN §3.2, §3.3). Native builds back it with
// database/sql + modernc.org/sqlite (driver_native.go); the wasm build backs it with
// a JS-provided wa-sqlite implementation over the JS↔wasm boundary (driver_wasm.go).
//
// Exec must accept multi-statement SQL (migrations rely on it). Query returns rows
// the caller iterates with Next/Scan. Both backends bind args positionally ('?').
type Driver interface {
	Exec(query string, args ...any) (Result, error)
	Query(query string, args ...any) (Rows, error)
	Close() error
}

// Result reports the effect of an Exec.
type Result interface {
	RowsAffected() (int64, error)
}

// Rows is a forward-only cursor. Callers must Close it. Scan supports the concrete
// pointer targets the repositories use: *string, *int, *int64, *float64, and *sql.NullString.
type Rows interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
	Close() error
}
