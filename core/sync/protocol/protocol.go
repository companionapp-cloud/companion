// Package protocol defines the sync wire types shared by the client engine
// (core/sync) and the server (apps/server). It depends only on core/domain, so the
// server never pulls in the client store or sync engine (PLAN §7).
package protocol

import (
	"time"

	"companion/core/domain"
)

// EntityNote is the entity_type tag for notes on the wire.
const EntityNote = "note"

// Push statuses.
const (
	StatusAccepted = "accepted"
	StatusConflict = "conflict"
)

// PushChange is a dirty client row offered to the server.
type PushChange struct {
	EntityType  string      `json:"entityType"`
	ID          string      `json:"id"`
	BaseVersion int64       `json:"baseVersion"`
	Row         domain.Note `json:"row"`
	UpdatedAt   time.Time   `json:"updatedAt"`
}

// PushRequest is the body of POST /v1/sync/push.
type PushRequest struct {
	Changes []PushChange `json:"changes"`
}

// PushResult is the server's per-row verdict.
type PushResult struct {
	ID        string       `json:"id"`
	Status    string       `json:"status"`
	Version   int64        `json:"version,omitempty"`
	ServerRow *domain.Note `json:"serverRow,omitempty"`
}

// PushResponse carries a verdict per pushed row.
type PushResponse struct {
	Results []PushResult `json:"results"`
}

// PullChange is one server-canonical row with its sequence.
type PullChange struct {
	EntityType string      `json:"entityType"`
	Row        domain.Note `json:"row"`
	ServerSeq  int64       `json:"serverSeq"`
}

// PullResponse is an ordered page of changes plus the next cursor.
type PullResponse struct {
	Changes    []PullChange `json:"changes"`
	NextCursor int64        `json:"nextCursor"`
}
