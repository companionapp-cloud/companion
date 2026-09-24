package syncserver

import (
	"database/sql"
	"encoding/json"
	"time"

	"companion/core/sync/protocol"
)

// CalDAV sync entities (PLAN-caldav.md §1.3). The server is a courier here and nothing more: it
// never contacts a calendar provider, so it has no use for any field of these rows beyond their
// sync metadata. Bodies are stored whole, exactly as pushed — on an encrypted account that means
// the provider URL, username, password, resource href and every event's ICS are ciphertext the
// server cannot read.

var (
	calendarAccountHandler = opaqueRowHandler(protocol.EntityCalendarAccount, "calendar_accounts")
	calendarObjectHandler  = opaqueRowHandler(protocol.EntityCalendarObject, "calendar_objects")
	// A scheduled Git export (core/export) is the same kind of courier job: the server never
	// contacts the Git host, and the row's repository, settings and credential are ciphertext.
	gitExportHandler = opaqueRowHandler(protocol.EntityGitExport, "git_exports")
	// A scheduled folder export only travels so the user's other devices know about it; the
	// folder's path and name are ciphertext.
	folderExportHandler = opaqueRowHandler(protocol.EntityFolderExport, "folder_exports")
	// Which guided tours the user has settled: nothing the server acts on.
	onboardingHandler = opaqueRowHandler(protocol.EntityOnboarding, "onboarding")
	// Pomodoros (focus sessions on tasks): nothing the server acts on.
	pomodoroHandler = opaqueRowHandler(protocol.EntityPomodoro, "pomodoros")
)

// opaqueRowMeta is the only part of an opaque body the server reads.
type opaqueRowMeta struct {
	ID        string     `json:"id"`
	CreatedAt time.Time  `json:"createdAt"`
	DeletedAt *time.Time `json:"deletedAt"`
}

// opaqueRowHandler builds the handler for an entity kept as a whole JSON body in `table`
// (id, user_id, row_json + the standard sync columns). table is a compile-time constant, never
// input, so splicing it into the SQL is safe.
func opaqueRowHandler(typ, table string) *entityHandler {
	return &entityHandler{
		typ:   typ,
		table: table,
		upsert: func(s *Server, tx *sql.Tx, uid string, raw []byte, updatedAt time.Time, version, seq int64) error {
			var m opaqueRowMeta
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
				`INSERT INTO `+table+` (id, user_id, row_json, created_at, updated_at, deleted_at, version, server_seq)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT (id) DO UPDATE SET
				   row_json = excluded.row_json, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
				   version = excluded.version, server_seq = excluded.server_seq;`),
				m.ID, uid, string(body), created.UTC().Format(timeFormat), updatedAt.Format(timeFormat), deletedAt, version, seq)
			return err
		},
		loadRaw: func(s *Server, tx *sql.Tx, uid, id string) ([]byte, error) {
			var body string
			if err := tx.QueryRow(s.rebind(`SELECT row_json FROM `+table+` WHERE id = ? AND user_id = ?;`), id, uid).Scan(&body); err != nil {
				return nil, err
			}
			return []byte(body), nil
		},
		pull: func(s *Server, uid string, cursor, limit int64) ([]seqRow, error) {
			rows, err := s.query(`SELECT row_json, server_seq FROM `+table+` WHERE user_id = ? AND server_seq > ? ORDER BY server_seq ASC LIMIT ?;`, uid, cursor, limit)
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
				out = append(out, seqRow{seq, protocol.PullChange{EntityType: typ, Row: json.RawMessage(body), ServerSeq: seq}})
			}
			return out, rows.Err()
		},
	}
}
