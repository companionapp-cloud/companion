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

	Notes          *NotesRepo
	Tasks          *TasksRepo
	Areas          *AreasRepo
	Projects       *ProjectsRepo
	ProjectMembers *ProjectMembersRepo
	ObjectTypes    *ObjectTypesRepo
	Links          *LinksRepo
	Search         *SearchRepo
	LLMConfigs     *LLMConfigsRepo
	Chats          *ChatsRepo
	ChatMessages   *ChatMessagesRepo
	// NotificationReads marks in-app notifications read; the feed itself is derived
	// from tasks (PLAN §6.4).
	NotificationReads *NotificationReadsRepo
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
	// Object types (archetypes) define the schemas that validate note/task props and drive
	// the reference-prop edges the link extractor resolves (PLAN §6.3). Wire it into the
	// link index as the schema resolver so prop:<field> edges derive identically on every
	// device, on both local writes and sync-apply.
	s.ObjectTypes = &ObjectTypesRepo{db: d, clock: clock}
	s.Links.schemas = s.ObjectTypes
	// Notes extract wikilinks into the shared index on every write and sync-apply, so
	// the graph stays current without re-parsing the knowledgebase (PLAN §5.1). They also
	// validate their props against their archetype's schema (PLAN §6.3).
	s.Notes = &NotesRepo{db: d, clock: clock, links: s.Links, objectTypes: s.ObjectTypes}
	// Tasks extract wikilinks from their notes into the shared index too, so a task is a
	// first-class graph node the moment it exists (PLAN §5.1, §6.4).
	s.Tasks = &TasksRepo{db: d, clock: clock, links: s.Links, objectTypes: s.ObjectTypes}
	s.Areas = &AreasRepo{db: d, clock: clock}
	s.Projects = &ProjectsRepo{db: d, clock: clock}
	// Project membership mirrors into the link index as authored 'member' edges.
	s.ProjectMembers = &ProjectMembersRepo{db: d, clock: clock, links: s.Links}
	// Full-text search reads the trigger-maintained notes_fts / tasks_fts indexes; it backs
	// the LLM search_notes retrieval tool (PLAN §6.8).
	s.Search = &SearchRepo{db: d}
	// LLM provider configs (device-local + account-scoped) back the chat assistant (§6.8).
	s.LLMConfigs = &LLMConfigsRepo{db: d, clock: clock}
	// Chats + their messages persist and sync conversations across devices (§6.8).
	s.Chats = &ChatsRepo{db: d, clock: clock}
	s.ChatMessages = &ChatMessagesRepo{db: d, clock: clock}
	// Read receipts for the in-app notification feed (PLAN §6.4).
	s.NotificationReads = &NotificationReadsRepo{db: d, clock: clock}
	return s, nil
}

// Close closes the underlying driver.
func (s *Store) Close() error { return s.db.Close() }
