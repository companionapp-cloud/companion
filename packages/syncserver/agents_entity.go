package syncserver

import (
	"database/sql"
	"encoding/json"
	"time"

	"companion/core/sync/protocol"
)

// The "agent" sync entity (PLAN-agents.md §1.4). Unlike the older per-column tables, the row
// body is kept whole in row_json — the server only needs the routing columns (runtime,
// host_device_id) and the standard sync metadata. Content fields inside the body arrive as
// enc$v1$ envelopes on encrypted accounts and are stored verbatim.

const agentCols = `row_json, server_seq`

// agentRowMeta is the subset of the body the server reads for its plaintext columns.
type agentRowMeta struct {
	ID           string     `json:"id"`
	Runtime      string     `json:"runtime"`
	HostDeviceID *string    `json:"hostDeviceId"`
	CreatedAt    time.Time  `json:"createdAt"`
	DeletedAt    *time.Time `json:"deletedAt"`
}

var agentHandler = &entityHandler{
	typ:   protocol.EntityAgent,
	table: "agents",
	upsert: func(s *Server, tx *sql.Tx, uid string, raw []byte, updatedAt time.Time, version, seq int64) error {
		var m agentRowMeta
		if err := json.Unmarshal(raw, &m); err != nil {
			return err
		}
		// Re-stamp the body's sync metadata so what other devices pull matches the columns.
		body, err := restampAgent(raw, updatedAt, version)
		if err != nil {
			return err
		}
		var deletedAt any
		if m.DeletedAt != nil {
			deletedAt = m.DeletedAt.UTC().Format(timeFormat)
		}
		created := m.CreatedAt
		if created.IsZero() {
			created = updatedAt
		}
		_, err = tx.Exec(s.rebind(
			`INSERT INTO agents (id, user_id, runtime, host_device_id, row_json, created_at, updated_at, deleted_at, version, server_seq)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET
			   runtime = excluded.runtime, host_device_id = excluded.host_device_id, row_json = excluded.row_json,
			   updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
			   version = excluded.version, server_seq = excluded.server_seq;`),
			m.ID, uid, m.Runtime, m.HostDeviceID, string(body),
			created.UTC().Format(timeFormat), updatedAt.Format(timeFormat), deletedAt, version, seq)
		return err
	},
	loadRaw: func(s *Server, tx *sql.Tx, uid, id string) ([]byte, error) {
		var body string
		var seq int64
		if err := tx.QueryRow(s.rebind(`SELECT `+agentCols+` FROM agents WHERE id = ? AND user_id = ?;`), id, uid).Scan(&body, &seq); err != nil {
			return nil, err
		}
		return []byte(body), nil
	},
	pull: func(s *Server, uid string, cursor, limit int64) ([]seqRow, error) {
		rows, err := s.query(`SELECT `+agentCols+` FROM agents WHERE user_id = ? AND server_seq > ? ORDER BY server_seq ASC LIMIT ?;`, uid, cursor, limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []seqRow
		for rows.Next() {
			var body string
			var seq int64
			if err := rows.Scan(&body, &seq); err != nil {
				return nil, err
			}
			out = append(out, seqRow{seq, protocol.PullChange{EntityType: protocol.EntityAgent, Row: json.RawMessage(body), ServerSeq: seq}})
		}
		return out, rows.Err()
	},
}

// restampAgent rewrites updatedAt/version/dirty in the stored body so a pulled row carries the
// server-canonical sync metadata (the per-column handlers achieve this by re-marshalling).
func restampAgent(raw []byte, updatedAt time.Time, version int64) ([]byte, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, err
	}
	ua, _ := json.Marshal(updatedAt.UTC())
	v, _ := json.Marshal(version)
	obj["updatedAt"] = ua
	obj["version"] = v
	obj["dirty"] = json.RawMessage("false")
	return json.Marshal(obj)
}
