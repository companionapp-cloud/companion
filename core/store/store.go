// Package store owns the client-side SQLite persistence: the embedded schema
// migrations and the per-entity repositories (PLAN §4.1, §7). It talks to SQLite
// only through the Driver interface, so the same code runs over modernc (native)
// and wa-sqlite (wasm). Milestone 1 wires notes; other tables exist but are not yet
// exercised.
package store

import "companion/core/domain"

// Store is the client's database (via an injected Driver) plus its repositories.
type Store struct {
	db    Driver
	clock domain.Clock

	Notes *NotesRepo
	Links *LinksRepo
}

// New builds a Store over an already-open Driver, applying pending migrations. A nil
// clock defaults to the system clock. Native callers usually use Open instead; the
// wasm shell injects its JS-backed driver here directly.
func New(d Driver, clock domain.Clock) (*Store, error) {
	if clock == nil {
		clock = domain.SystemClock{}
	}
	if err := migrate(d); err != nil {
		d.Close()
		return nil, err
	}
	s := &Store{db: d, clock: clock}
	s.Links = &LinksRepo{db: d}
	// Notes extract wikilinks into the shared index on every write and sync-apply, so
	// the graph stays current without re-parsing the knowledgebase (PLAN §5.1).
	s.Notes = &NotesRepo{db: d, clock: clock, links: s.Links}
	return s, nil
}

// Close closes the underlying driver.
func (s *Store) Close() error { return s.db.Close() }
