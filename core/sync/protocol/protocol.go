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
	// A project-scoped, drag-ordered task list and its rows (task refs + headings).
	EntityList       = "list"
	EntityListItem   = "list_item"
	EntityObjectType = "object_type"
	// A document is a file embed: metadata syncs here; its bytes move out-of-band through
	// the blob endpoints (PLAN §6.9).
	EntityDocument    = "document"
	EntityChat        = "chat"
	EntityChatMessage = "chat_message"
	// An installed AI agent (PLAN-agents.md): cloud API or a desktop-hosted local tool. The
	// runtime and host device id stay plaintext so any device can route to the host.
	EntityAgent = "agent"
	// A read receipt for one in-app notification fire (PLAN §6.4).
	EntityNotificationRead = "notification_read"
	// One calendar (PLAN §6.7): an ICS subscription or a CalDAV collection. Syncs bidirectionally.
	EntityCalendarFeed = "calendar_feed"
	// One expanded event occurrence (PLAN §6.7, §E2EE). Derived on-device from ICS and pushed
	// encrypted like any entity.
	EntityCalendarEvent = "calendar_event"
	// A CalDAV login, and one calendar object resource of a CalDAV calendar (PLAN-caldav.md).
	// Both sync so any native device can write changes back to the provider; the server stores
	// them as opaque bodies and never contacts the provider itself.
	EntityCalendarAccount = "calendar_account"
	EntityCalendarObject  = "calendar_object"
	// A canvas board, its nodes, and its edges (PLAN-canvases.md). Three row types so two
	// devices editing different nodes of one board merge per row instead of forking.
	EntityCanvas     = "canvas"
	EntityCanvasNode = "canvas_node"
	EntityCanvasEdge = "canvas_edge"
	// One ink group drawn over a note (PLAN-drawing.md): its strokes and the text anchor that
	// pins it to the note. Keyed by note id; the payload is encrypted whole.
	EntityNoteInk = "note_ink"
	// A scheduled export to a Git repository (core/export): the repository, the schedule, the
	// device that runs it, and the credential — so it is set up once for every device. Stored
	// by the server as an opaque body.
	EntityGitExport = "git_export"
	// A scheduled export to a folder on one device's disk. It syncs so the other devices know
	// the folder is being written, and can pause it or take it over; only the device named in it
	// ever writes. Stored by the server as an opaque body, like a Git export.
	EntityFolderExport = "folder_export"
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
