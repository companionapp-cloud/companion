package syncserver

import (
	"database/sql"
	"encoding/json"
	"time"

	"companion/core/domain"
	"companion/core/sync/protocol"
)

// ---- lists ---------------------------------------------------------------
//
// Project-scoped, drag-ordered task lists and their rows (task references + grouping
// headings). Both are ordinary synced entities: the server stores what the client sends
// and echoes it on pull; ordering is a plain sort_order column on each row.

const listCols = `id, project_id, name, sort_order, created_at, updated_at, deleted_at, version, server_seq`

var listHandler = &entityHandler{
	typ:   protocol.EntityList,
	table: "lists",
	upsert: func(s *Server, tx *sql.Tx, uid string, raw []byte, updatedAt time.Time, version, seq int64) error {
		var l domain.List
		if err := json.Unmarshal(raw, &l); err != nil {
			return err
		}
		var deletedAt any
		if l.DeletedAt != nil {
			deletedAt = l.DeletedAt.UTC().Format(timeFormat)
		}
		_, err := tx.Exec(s.rebind(
			`INSERT INTO lists (id, user_id, project_id, name, sort_order, created_at, updated_at, deleted_at, version, server_seq)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET
			   project_id = excluded.project_id, name = excluded.name, sort_order = excluded.sort_order,
			   updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
			   version = excluded.version, server_seq = excluded.server_seq;`),
			l.ID, uid, l.ProjectID, l.Name, l.SortOrder,
			l.CreatedAt.UTC().Format(timeFormat), updatedAt.Format(timeFormat), deletedAt, version, seq)
		return err
	},
	loadRaw: func(s *Server, tx *sql.Tx, uid, id string) ([]byte, error) {
		row := tx.QueryRow(s.rebind(`SELECT `+listCols+` FROM lists WHERE id = ? AND user_id = ?;`), id, uid)
		l, _, err := scanServerList(row)
		if err != nil {
			return nil, err
		}
		return json.Marshal(l)
	},
	pull: func(s *Server, uid string, cursor, limit int64) ([]seqRow, error) {
		rows, err := s.query(`SELECT `+listCols+` FROM lists WHERE user_id = ? AND server_seq > ? ORDER BY server_seq ASC LIMIT ?;`, uid, cursor, limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []seqRow
		for rows.Next() {
			l, seq, err := scanServerList(rows)
			if err != nil {
				return nil, err
			}
			body, err := json.Marshal(l)
			if err != nil {
				return nil, err
			}
			out = append(out, seqRow{seq, protocol.PullChange{EntityType: protocol.EntityList, Row: body, ServerSeq: seq}})
		}
		return out, rows.Err()
	},
}

func scanServerList(sc rowScanner) (*domain.List, int64, error) {
	var (
		l                    domain.List
		deletedAt            sql.NullString
		createdAt, updatedAt string
		seq                  int64
	)
	if err := sc.Scan(&l.ID, &l.ProjectID, &l.Name, &l.SortOrder, &createdAt, &updatedAt, &deletedAt, &l.Version, &seq); err != nil {
		return nil, 0, err
	}
	if err := parseTimes(createdAt, updatedAt, deletedAt, &l.CreatedAt, &l.UpdatedAt, &l.DeletedAt); err != nil {
		return nil, 0, err
	}
	return &l, seq, nil
}

// ---- list items ----------------------------------------------------------

const listItemCols = `id, list_id, kind, task_id, title, sort_order, created_at, updated_at, deleted_at, version, server_seq`

var listItemHandler = &entityHandler{
	typ:   protocol.EntityListItem,
	table: "list_items",
	upsert: func(s *Server, tx *sql.Tx, uid string, raw []byte, updatedAt time.Time, version, seq int64) error {
		var it domain.ListItem
		if err := json.Unmarshal(raw, &it); err != nil {
			return err
		}
		var deletedAt any
		if it.DeletedAt != nil {
			deletedAt = it.DeletedAt.UTC().Format(timeFormat)
		}
		_, err := tx.Exec(s.rebind(
			`INSERT INTO list_items (id, user_id, list_id, kind, task_id, title, sort_order, created_at, updated_at, deleted_at, version, server_seq)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET
			   list_id = excluded.list_id, kind = excluded.kind, task_id = excluded.task_id,
			   title = excluded.title, sort_order = excluded.sort_order,
			   updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
			   version = excluded.version, server_seq = excluded.server_seq;`),
			it.ID, uid, it.ListID, it.Kind, it.TaskID, it.Title, it.SortOrder,
			it.CreatedAt.UTC().Format(timeFormat), updatedAt.Format(timeFormat), deletedAt, version, seq)
		return err
	},
	loadRaw: func(s *Server, tx *sql.Tx, uid, id string) ([]byte, error) {
		row := tx.QueryRow(s.rebind(`SELECT `+listItemCols+` FROM list_items WHERE id = ? AND user_id = ?;`), id, uid)
		it, _, err := scanServerListItem(row)
		if err != nil {
			return nil, err
		}
		return json.Marshal(it)
	},
	pull: func(s *Server, uid string, cursor, limit int64) ([]seqRow, error) {
		rows, err := s.query(`SELECT `+listItemCols+` FROM list_items WHERE user_id = ? AND server_seq > ? ORDER BY server_seq ASC LIMIT ?;`, uid, cursor, limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []seqRow
		for rows.Next() {
			it, seq, err := scanServerListItem(rows)
			if err != nil {
				return nil, err
			}
			body, err := json.Marshal(it)
			if err != nil {
				return nil, err
			}
			out = append(out, seqRow{seq, protocol.PullChange{EntityType: protocol.EntityListItem, Row: body, ServerSeq: seq}})
		}
		return out, rows.Err()
	},
}

func scanServerListItem(sc rowScanner) (*domain.ListItem, int64, error) {
	var (
		it                   domain.ListItem
		taskID, deletedAt    sql.NullString
		createdAt, updatedAt string
		seq                  int64
	)
	if err := sc.Scan(&it.ID, &it.ListID, &it.Kind, &taskID, &it.Title, &it.SortOrder, &createdAt, &updatedAt, &deletedAt, &it.Version, &seq); err != nil {
		return nil, 0, err
	}
	if taskID.Valid {
		it.TaskID = &taskID.String
	}
	if err := parseTimes(createdAt, updatedAt, deletedAt, &it.CreatedAt, &it.UpdatedAt, &it.DeletedAt); err != nil {
		return nil, 0, err
	}
	return &it, seq, nil
}
