package main

import (
	"database/sql"
	"net/http"
	"strconv"
	"time"

	"companion/core/domain"
	"companion/core/sync/protocol"
)

const defaultPullLimit = 500

// handlePull returns the ordered slice of rows with server_seq > cursor (PLAN §5.1).
func (s *Server) handlePull(w http.ResponseWriter, r *http.Request) {
	uid := userID(r)
	cursor, _ := strconv.ParseInt(r.URL.Query().Get("cursor"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > defaultPullLimit {
		limit = defaultPullLimit
	}

	rows, err := s.query(
		`SELECT id, title, content_md, date, created_at, updated_at, deleted_at, version, server_seq
		 FROM notes WHERE user_id = ? AND server_seq > ? ORDER BY server_seq ASC LIMIT ?;`,
		uid, cursor, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "pull failed")
		return
	}
	defer rows.Close()

	resp := protocol.PullResponse{Changes: []protocol.PullChange{}, NextCursor: cursor}
	for rows.Next() {
		note, seq, err := scanServerNote(rows)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "scan failed")
			return
		}
		resp.Changes = append(resp.Changes, protocol.PullChange{EntityType: protocol.EntityNote, Row: *note, ServerSeq: seq})
		resp.NextCursor = seq
	}
	writeJSON(w, http.StatusOK, resp)
}

// handlePush applies each dirty client row under optimistic concurrency (PLAN §5.2).
func (s *Server) handlePush(w http.ResponseWriter, r *http.Request) {
	uid := userID(r)
	var req protocol.PushRequest
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	results := make([]protocol.PushResult, 0, len(req.Changes))
	var maxSeq int64
	for _, ch := range req.Changes {
		res, seq, err := s.applyPush(uid, ch)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "push failed")
			return
		}
		if seq > maxSeq {
			maxSeq = seq
		}
		results = append(results, res)
	}
	// Fan out to this user's other online devices (PLAN §7.5). Fire-and-forget after
	// the writes committed; the originating device hears its own echo but no-ops
	// (its cursor already advanced past this seq during the push above).
	if maxSeq > 0 {
		s.hub.publish(uid, maxSeq)
	}
	writeJSON(w, http.StatusOK, protocol.PushResponse{Results: results})
}

// applyPush applies one client row and returns the result plus the server_seq it was
// assigned (0 when nothing was written, i.e. a conflict). The seq feeds the realtime
// change fan-out (PLAN §7.5).
func (s *Server) applyPush(userID string, ch protocol.PushChange) (protocol.PushResult, int64, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return protocol.PushResult{}, 0, err
	}
	defer tx.Rollback()

	existing, exists, err := s.loadNote(tx, userID, ch.ID)
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
		version := int64(1)
		if exists {
			version = existing.Version + 1
		}
		seq, err := s.nextSeq(tx, userID)
		if err != nil {
			return protocol.PushResult{}, 0, err
		}
		if err := s.upsertNote(tx, userID, ch.Row, clientUpdated, version, seq); err != nil {
			return protocol.PushResult{}, 0, err
		}
		if err := tx.Commit(); err != nil {
			return protocol.PushResult{}, 0, err
		}
		return protocol.PushResult{ID: ch.ID, Status: protocol.StatusAccepted, Version: version}, seq, nil
	}

	switch {
	case !exists:
		return accept()
	case existing.Version == ch.BaseVersion:
		return accept()
	default:
		// Stale push: the row moved on since the client last saw it. Server wins
		// only if it is at least as new; otherwise the client is newer, apply it.
		if !existing.UpdatedAt.Before(clientUpdated) {
			return protocol.PushResult{ID: ch.ID, Status: protocol.StatusConflict, ServerRow: existing}, 0, nil
		}
		return accept()
	}
}

// loadNote reads a user's note (business fields + version), reporting existence.
func (s *Server) loadNote(tx *sql.Tx, userID, id string) (*domain.Note, bool, error) {
	row := tx.QueryRow(s.rebind(
		`SELECT id, title, content_md, date, created_at, updated_at, deleted_at, version, 0
		 FROM notes WHERE id = ? AND user_id = ?;`), id, userID)
	note, _, err := scanServerNote(row)
	if err == sql.ErrNoRows {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return note, true, nil
}

// upsertNote writes the client's business fields with a server-assigned version and
// sequence, preserving created_at on update.
func (s *Server) upsertNote(tx *sql.Tx, userID string, n domain.Note, updatedAt time.Time, version, seq int64) error {
	var deletedAt any
	if n.DeletedAt != nil {
		deletedAt = n.DeletedAt.UTC().Format(timeFormat)
	}
	_, err := tx.Exec(s.rebind(
		`INSERT INTO notes (id, user_id, title, content_md, date, created_at, updated_at, deleted_at, version, server_seq)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (id) DO UPDATE SET
		   title = excluded.title, content_md = excluded.content_md, date = excluded.date,
		   updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
		   version = excluded.version, server_seq = excluded.server_seq;`),
		n.ID, userID, n.Title, n.ContentMD, n.Date,
		n.CreatedAt.UTC().Format(timeFormat), updatedAt.Format(timeFormat), deletedAt, version, seq,
	)
	return err
}

// rowScanner is satisfied by *sql.Row and *sql.Rows.
type rowScanner interface {
	Scan(dest ...any) error
}

func scanServerNote(sc rowScanner) (*domain.Note, int64, error) {
	var (
		n                    domain.Note
		date, deletedAt      sql.NullString
		createdAt, updatedAt string
		seq                  int64
	)
	if err := sc.Scan(&n.ID, &n.Title, &n.ContentMD, &date, &createdAt, &updatedAt, &deletedAt, &n.Version, &seq); err != nil {
		return nil, 0, err
	}
	if date.Valid {
		n.Date = &date.String
	}
	var err error
	if n.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, 0, err
	}
	if n.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, 0, err
	}
	if deletedAt.Valid {
		t, err := time.Parse(timeFormat, deletedAt.String)
		if err != nil {
			return nil, 0, err
		}
		n.DeletedAt = &t
	}
	return &n, seq, nil
}
