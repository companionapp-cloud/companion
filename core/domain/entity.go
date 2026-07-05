package domain

import "time"

// SyncEntity is the minimal shape the sync engine needs from every syncable row,
// regardless of its business columns (PLAN §7). It lets one generic push/pull/conflict
// path serve notes, areas, projects, project members, and every entity a later
// milestone adds. Each entity type keeps its own table and struct (there is
// deliberately no generic node table — PLAN §4.0); this interface is the seam.
type SyncEntity interface {
	SyncID() string
	SyncVersion() int64
	SyncUpdatedAt() time.Time
	SyncDeleted() bool
	SyncDirty() bool
}
