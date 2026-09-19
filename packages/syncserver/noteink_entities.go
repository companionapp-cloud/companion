package syncserver

import (
	"database/sql"
	"encoding/json"
	"time"

	"companion/core/domain"
	"companion/core/sync/protocol"
)

// Server SQL for note ink (PLAN-drawing.md): one row per ink group drawn over a note. The
// payload arrives as an opaque envelope string on an encrypted account and is stored
// verbatim; note_id stays a column so the Trash collector can take a purged note's ink with it.

const noteInkCols = `id, note_id, data_json, created_at, updated_at, deleted_at, version, server_seq`

var noteInkHandler = &entityHandler{
	typ:   protocol.EntityNoteInk,
	table: "note_ink",
	upsert: func(s *Server, tx *sql.Tx, uid string, raw []byte, updatedAt time.Time, version, seq int64) error {
		var g domain.NoteInk
		if err := json.Unmarshal(raw, &g); err != nil {
			return err
		}
		data := string(g.Data)
		if data == "" || data == "null" {
			data = "{}"
		}
		_, err := tx.Exec(s.rebind(
			`INSERT INTO note_ink (id, user_id, note_id, data_json, created_at, updated_at, deleted_at, version, server_seq)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET
			   note_id = excluded.note_id, data_json = excluded.data_json, updated_at = excluded.updated_at,
			   deleted_at = excluded.deleted_at, version = excluded.version, server_seq = excluded.server_seq;`),
			g.ID, uid, g.NoteID, data, g.CreatedAt.UTC().Format(timeFormat), updatedAt.Format(timeFormat),
			fmtTime(g.DeletedAt), version, seq)
		return err
	},
	loadRaw: func(s *Server, tx *sql.Tx, uid, id string) ([]byte, error) {
		row := tx.QueryRow(s.rebind(`SELECT `+noteInkCols+` FROM note_ink WHERE id = ? AND user_id = ?;`), id, uid)
		g, _, err := scanServerNoteInk(row)
		if err != nil {
			return nil, err
		}
		return json.Marshal(g)
	},
	pull: func(s *Server, uid string, cursor, limit int64) ([]seqRow, error) {
		rows, err := s.query(`SELECT `+noteInkCols+` FROM note_ink WHERE user_id = ? AND server_seq > ? ORDER BY server_seq ASC LIMIT ?;`, uid, cursor, limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []seqRow
		for rows.Next() {
			g, seq, err := scanServerNoteInk(rows)
			if err != nil {
				return nil, err
			}
			body, err := json.Marshal(g)
			if err != nil {
				return nil, err
			}
			out = append(out, seqRow{seq, protocol.PullChange{EntityType: protocol.EntityNoteInk, Row: body, ServerSeq: seq}})
		}
		return out, rows.Err()
	},
}

func scanServerNoteInk(sc rowScanner) (*domain.NoteInk, int64, error) {
	var (
		g                          domain.NoteInk
		deletedAt                  sql.NullString
		data, createdAt, updatedAt string
		seq                        int64
	)
	if err := sc.Scan(&g.ID, &g.NoteID, &data, &createdAt, &updatedAt, &deletedAt, &g.Version, &seq); err != nil {
		return nil, 0, err
	}
	if data == "" {
		data = "{}"
	}
	g.Data = json.RawMessage(data)
	if err := parseTimes(createdAt, updatedAt, deletedAt, &g.CreatedAt, &g.UpdatedAt, &g.DeletedAt); err != nil {
		return nil, 0, err
	}
	return &g, seq, nil
}
