package main

import (
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"strconv"
	"time"

	"companion/core/domain"
	"companion/core/sync/protocol"
)

// isSeedRow reports whether a pushed task row is a repeating-task seed (rule set, not itself
// an occurrence), so its occurrences should be re-materialized. A decode failure is treated
// as "not a seed" — the row already upserted fine; only materialization is skipped.
func isSeedRow(raw json.RawMessage) bool {
	var t domain.Task
	if err := json.Unmarshal(raw, &t); err != nil {
		return false
	}
	return t.IsRepeatSeed()
}

const defaultPullLimit = 500

// entityHandler describes how one syncable table is stored on the server and echoed on
// the wire. The conflict rule, sequence assignment, and pull ordering are generic
// (below); each handler only supplies the per-table SQL. Row bodies cross the wire as
// opaque JSON tagged by entity type (PLAN §7).
type entityHandler struct {
	typ   string
	table string
	// upsert writes the client's row (decoded from raw) with a server-assigned version
	// and sequence, preserving created_at on update.
	upsert func(s *Server, tx *sql.Tx, uid string, raw []byte, updatedAt time.Time, version, seq int64) error
	// loadRaw returns the server-canonical row as wire JSON, for a conflict response.
	loadRaw func(s *Server, tx *sql.Tx, uid, id string) ([]byte, error)
	// pull returns this table's rows with server_seq > cursor, ascending, up to limit.
	pull func(s *Server, uid string, cursor, limit int64) ([]seqRow, error)
}

// seqRow pairs a pulled change with its server_seq so pages from every table can be
// merged into one globally-ordered stream.
type seqRow struct {
	seq    int64
	change protocol.PullChange
}

// handlers is the per-entity registry, built once. Adding an entity in a later
// milestone is one entry here plus its SQL (see server_entities.go).
func (s *Server) handlers() map[string]*entityHandler {
	if s.entities == nil {
		s.entities = map[string]*entityHandler{
			protocol.EntityNote:          noteHandler,
			protocol.EntityTask:          taskHandler,
			protocol.EntityArea:          areaHandler,
			protocol.EntityProject:       projectHandler,
			protocol.EntityProjectMember: memberHandler,
			protocol.EntityObjectType:    objectTypeHandler,
			protocol.EntityDocument:      documentHandler,
			protocol.EntityChat:             chatHandler,
			protocol.EntityChatMessage:      chatMessageHandler,
			protocol.EntityNotificationRead: notificationReadHandler,
		}
	}
	return s.entities
}

// handlePull merges every table's rows with server_seq > cursor into one ascending
// page (PLAN §4.2). Each table is queried for up to `limit` rows; the global first
// `limit` by seq are guaranteed to lie within that union, so a k-way merge + truncate
// yields the correct idempotent page.
func (s *Server) handlePull(w http.ResponseWriter, r *http.Request) {
	uid := userID(r)
	cursor, _ := strconv.ParseInt(r.URL.Query().Get("cursor"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > defaultPullLimit {
		limit = defaultPullLimit
	}

	var all []seqRow
	for _, e := range s.handlers() {
		rows, err := e.pull(s, uid, cursor, int64(limit))
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "pull failed")
			return
		}
		all = append(all, rows...)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].seq < all[j].seq })
	if len(all) > limit {
		all = all[:limit]
	}

	resp := protocol.PullResponse{Changes: make([]protocol.PullChange, 0, len(all)), NextCursor: cursor}
	for _, row := range all {
		resp.Changes = append(resp.Changes, row.change)
		resp.NextCursor = row.seq
	}
	writeJSON(w, http.StatusOK, resp)
}

// handlePush applies each dirty client row under optimistic concurrency (PLAN §7.2),
// then fans a realtime change notification out to the user's other devices (§7.5).
func (s *Server) handlePush(w http.ResponseWriter, r *http.Request) {
	uid := userID(r)
	var req protocol.PushRequest
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	handlers := s.handlers()
	results := make([]protocol.PushResult, 0, len(req.Changes))
	var maxSeq int64
	seedIDs := map[string]bool{} // repeating-task seeds touched by this push
	for _, ch := range req.Changes {
		e := handlers[ch.EntityType]
		if e == nil {
			// Unknown entity type (client newer than server): reject just this row.
			results = append(results, protocol.PushResult{ID: ch.ID, Status: protocol.StatusConflict})
			continue
		}
		res, seq, err := s.applyPush(e, uid, ch)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "push failed")
			return
		}
		if seq > maxSeq {
			maxSeq = seq
		}
		if res.Status == protocol.StatusAccepted && ch.EntityType == protocol.EntityTask && isSeedRow(ch.Row) {
			seedIDs[ch.ID] = true
		}
		results = append(results, res)
	}
	// A pushed seed — created, its rule edited, or trashed/deleted — materializes its
	// occurrences immediately, so the change reaches other devices via the same SSE poke as
	// the push itself (PLAN §6.4). Materialization failures are logged, never failing the
	// push: the hourly sweep is the backstop.
	for id := range seedIDs {
		n, seq, err := s.materializeSeed(uid, id)
		if err != nil {
			log.Printf("push: materialize seed %s: %v", id, err)
			continue
		}
		if n > 0 && seq > maxSeq {
			maxSeq = seq
		}
	}
	if maxSeq > 0 {
		s.hub.publish(uid, maxSeq)
	}
	writeJSON(w, http.StatusOK, protocol.PushResponse{Results: results})
}

// applyPush applies one client row of any entity type and returns the result plus the
// server_seq it was assigned (0 when nothing was written, i.e. a conflict).
func (s *Server) applyPush(e *entityHandler, uid string, ch protocol.PushChange) (protocol.PushResult, int64, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return protocol.PushResult{}, 0, err
	}
	defer tx.Rollback()

	version, serverUpdated, exists, err := s.loadMeta(tx, e.table, uid, ch.ID)
	if err != nil {
		return protocol.PushResult{}, 0, err
	}

	// Clamp client timestamps arriving from the future (PLAN §10).
	now := s.clock.Now().UTC()
	clientUpdated := ch.UpdatedAt.UTC()
	if clientUpdated.After(now) {
		clientUpdated = now
	}

	accept := func() (protocol.PushResult, int64, error) {
		newVersion := int64(1)
		if exists {
			newVersion = version + 1
		}
		seq, err := s.nextSeq(tx, uid)
		if err != nil {
			return protocol.PushResult{}, 0, err
		}
		if err := e.upsert(s, tx, uid, ch.Row, clientUpdated, newVersion, seq); err != nil {
			return protocol.PushResult{}, 0, err
		}
		if err := tx.Commit(); err != nil {
			return protocol.PushResult{}, 0, err
		}
		return protocol.PushResult{ID: ch.ID, Status: protocol.StatusAccepted, Version: newVersion}, seq, nil
	}

	switch {
	case !exists:
		return accept()
	case version == ch.BaseVersion:
		return accept()
	default:
		// Stale push: the row moved on since the client last saw it. Server wins only
		// if it is at least as new; otherwise the client is newer, apply it.
		if !serverUpdated.Before(clientUpdated) {
			raw, err := e.loadRaw(s, tx, uid, ch.ID)
			if err != nil {
				return protocol.PushResult{}, 0, err
			}
			return protocol.PushResult{ID: ch.ID, Status: protocol.StatusConflict, ServerRow: raw}, 0, nil
		}
		return accept()
	}
}

// loadMeta reads a row's version and updated_at for the conflict rule, reporting
// existence. Every syncable table has these columns, so this is table-agnostic.
func (s *Server) loadMeta(tx *sql.Tx, table, uid, id string) (version int64, updatedAt time.Time, exists bool, err error) {
	var ua string
	row := tx.QueryRow(s.rebind(`SELECT version, updated_at FROM `+table+` WHERE id = ? AND user_id = ?;`), id, uid)
	if err = row.Scan(&version, &ua); err != nil {
		if err == sql.ErrNoRows {
			return 0, time.Time{}, false, nil
		}
		return 0, time.Time{}, false, err
	}
	updatedAt, err = time.Parse(timeFormat, ua)
	if err != nil {
		return 0, time.Time{}, false, err
	}
	return version, updatedAt, true, nil
}

// rowScanner is satisfied by *sql.Row and *sql.Rows.
type rowScanner interface {
	Scan(dest ...any) error
}
