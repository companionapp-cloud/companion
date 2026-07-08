// Package protocol defines the sync wire types shared by the client engine
// (core/sync) and the server (apps/server). It depends only on the standard library,
// so the server never pulls in the client store or sync engine (PLAN §7). Row bodies
// travel as opaque JSON tagged by EntityType, so one push/pull path serves every
// syncable entity.
package protocol

import (
	"encoding/json"
	"time"
)

// Entity type tags on the wire (PLAN §7). Every syncable table has one.
const (
	EntityNote          = "note"
	EntityTask          = "task"
	EntityArea          = "area"
	EntityProject       = "project"
	EntityProjectMember = "project_member"
	EntityObjectType    = "object_type"
	// A document is a file embed: metadata syncs here; its bytes move out-of-band through
	// the blob endpoints (PLAN §6.9).
	EntityDocument = "document"
	EntityChat     = "chat"
	EntityChatMessage   = "chat_message"
	// A read receipt for one in-app notification fire (PLAN §6.4).
	EntityNotificationRead = "notification_read"
)

// Push statuses.
const (
	StatusAccepted = "accepted"
	StatusConflict = "conflict"
)

// PushChange is a dirty client row offered to the server. Row is the entity's JSON
// body, opaque to the transport; both ends decode it by EntityType.
type PushChange struct {
	EntityType  string          `json:"entityType"`
	ID          string          `json:"id"`
	BaseVersion int64           `json:"baseVersion"`
	Row         json.RawMessage `json:"row"`
	UpdatedAt   time.Time       `json:"updatedAt"`
}

// PushRequest is the body of POST /v1/sync/push.
type PushRequest struct {
	Changes []PushChange `json:"changes"`
}

// PushResult is the server's per-row verdict. ServerRow carries the server-canonical
// JSON body on a conflict (so the client can adopt it and fork a conflicted copy).
type PushResult struct {
	ID        string          `json:"id"`
	Status    string          `json:"status"`
	Version   int64           `json:"version,omitempty"`
	ServerRow json.RawMessage `json:"serverRow,omitempty"`
}

// PushResponse carries a verdict per pushed row, in the same order as the request.
type PushResponse struct {
	Results []PushResult `json:"results"`
}

// PullChange is one server-canonical row (opaque JSON) with its type and sequence.
type PullChange struct {
	EntityType string          `json:"entityType"`
	Row        json.RawMessage `json:"row"`
	ServerSeq  int64           `json:"serverSeq"`
}

// PullResponse is an ordered page of changes plus the next cursor.
type PullResponse struct {
	Changes    []PullChange `json:"changes"`
	NextCursor int64        `json:"nextCursor"`
}
