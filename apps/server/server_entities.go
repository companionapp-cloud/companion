package main

import (
	"database/sql"
	"encoding/json"
	"time"

	"companion/core/domain"
	"companion/core/sync/protocol"
)

// This file holds the per-entity server SQL wired into the generic sync machinery in
// sync.go. Each handler decodes the wire row into its core/domain struct, upserts the
// business columns (preserving created_at on update), and scans rows back out for
// pull/conflict responses. The server reuses core/domain as the single entity
// definition (PLAN §4.2, §8) but keeps its own Postgres/SQLite persistence.

// ---- notes ---------------------------------------------------------------

const noteCols = `id, title, content_md, date, created_at, updated_at, deleting_at, deleted_at, version, server_seq`

var noteHandler = &entityHandler{
	typ:   protocol.EntityNote,
	table: "notes",
	upsert: func(s *Server, tx *sql.Tx, uid string, raw []byte, updatedAt time.Time, version, seq int64) error {
		var n domain.Note
		if err := json.Unmarshal(raw, &n); err != nil {
			return err
		}
		var deletingAt, deletedAt any
		if n.DeletingAt != nil {
			deletingAt = n.DeletingAt.UTC().Format(timeFormat)
		}
		if n.DeletedAt != nil {
			deletedAt = n.DeletedAt.UTC().Format(timeFormat)
		}
		_, err := tx.Exec(s.rebind(
			`INSERT INTO notes (id, user_id, title, content_md, date, created_at, updated_at, deleting_at, deleted_at, version, server_seq)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET
			   title = excluded.title, content_md = excluded.content_md, date = excluded.date,
			   updated_at = excluded.updated_at, deleting_at = excluded.deleting_at,
			   deleted_at = excluded.deleted_at,
			   version = excluded.version, server_seq = excluded.server_seq;`),
			n.ID, uid, n.Title, n.ContentMD, n.Date,
			n.CreatedAt.UTC().Format(timeFormat), updatedAt.Format(timeFormat), deletingAt, deletedAt, version, seq)
		return err
	},
	loadRaw: func(s *Server, tx *sql.Tx, uid, id string) ([]byte, error) {
		row := tx.QueryRow(s.rebind(`SELECT `+noteCols+` FROM notes WHERE id = ? AND user_id = ?;`), id, uid)
		n, _, err := scanServerNote(row)
		if err != nil {
			return nil, err
		}
		return json.Marshal(n)
	},
	pull: func(s *Server, uid string, cursor, limit int64) ([]seqRow, error) {
		rows, err := s.query(`SELECT `+noteCols+` FROM notes WHERE user_id = ? AND server_seq > ? ORDER BY server_seq ASC LIMIT ?;`, uid, cursor, limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []seqRow
		for rows.Next() {
			n, seq, err := scanServerNote(rows)
			if err != nil {
				return nil, err
			}
			body, err := json.Marshal(n)
			if err != nil {
				return nil, err
			}
			out = append(out, seqRow{seq, protocol.PullChange{EntityType: protocol.EntityNote, Row: body, ServerSeq: seq}})
		}
		return out, rows.Err()
	},
}

func scanServerNote(sc rowScanner) (*domain.Note, int64, error) {
	var (
		n                           domain.Note
		date, deletingAt, deletedAt sql.NullString
		createdAt, updatedAt        string
		seq                         int64
	)
	if err := sc.Scan(&n.ID, &n.Title, &n.ContentMD, &date, &createdAt, &updatedAt, &deletingAt, &deletedAt, &n.Version, &seq); err != nil {
		return nil, 0, err
	}
	if date.Valid {
		n.Date = &date.String
	}
	if err := parseTimes(createdAt, updatedAt, deletedAt, &n.CreatedAt, &n.UpdatedAt, &n.DeletedAt); err != nil {
		return nil, 0, err
	}
	if deletingAt.Valid {
		t, err := time.Parse(timeFormat, deletingAt.String)
		if err != nil {
			return nil, 0, err
		}
		n.DeletingAt = &t
	}
	return &n, seq, nil
}

// ---- areas ---------------------------------------------------------------

const areaCols = `id, name, color, sort_order, created_at, updated_at, deleted_at, version, server_seq`

var areaHandler = &entityHandler{
	typ:   protocol.EntityArea,
	table: "areas",
	upsert: func(s *Server, tx *sql.Tx, uid string, raw []byte, updatedAt time.Time, version, seq int64) error {
		var a domain.Area
		if err := json.Unmarshal(raw, &a); err != nil {
			return err
		}
		var deletedAt any
		if a.DeletedAt != nil {
			deletedAt = a.DeletedAt.UTC().Format(timeFormat)
		}
		_, err := tx.Exec(s.rebind(
			`INSERT INTO areas (id, user_id, name, color, sort_order, created_at, updated_at, deleted_at, version, server_seq)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET
			   name = excluded.name, color = excluded.color, sort_order = excluded.sort_order,
			   updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
			   version = excluded.version, server_seq = excluded.server_seq;`),
			a.ID, uid, a.Name, a.Color, a.SortOrder,
			a.CreatedAt.UTC().Format(timeFormat), updatedAt.Format(timeFormat), deletedAt, version, seq)
		return err
	},
	loadRaw: func(s *Server, tx *sql.Tx, uid, id string) ([]byte, error) {
		row := tx.QueryRow(s.rebind(`SELECT `+areaCols+` FROM areas WHERE id = ? AND user_id = ?;`), id, uid)
		a, _, err := scanServerArea(row)
		if err != nil {
			return nil, err
		}
		return json.Marshal(a)
	},
	pull: func(s *Server, uid string, cursor, limit int64) ([]seqRow, error) {
		rows, err := s.query(`SELECT `+areaCols+` FROM areas WHERE user_id = ? AND server_seq > ? ORDER BY server_seq ASC LIMIT ?;`, uid, cursor, limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []seqRow
		for rows.Next() {
			a, seq, err := scanServerArea(rows)
			if err != nil {
				return nil, err
			}
			body, err := json.Marshal(a)
			if err != nil {
				return nil, err
			}
			out = append(out, seqRow{seq, protocol.PullChange{EntityType: protocol.EntityArea, Row: body, ServerSeq: seq}})
		}
		return out, rows.Err()
	},
}

func scanServerArea(sc rowScanner) (*domain.Area, int64, error) {
	var (
		a                    domain.Area
		color, deletedAt     sql.NullString
		createdAt, updatedAt string
		seq                  int64
	)
	if err := sc.Scan(&a.ID, &a.Name, &color, &a.SortOrder, &createdAt, &updatedAt, &deletedAt, &a.Version, &seq); err != nil {
		return nil, 0, err
	}
	if color.Valid {
		a.Color = &color.String
	}
	if err := parseTimes(createdAt, updatedAt, deletedAt, &a.CreatedAt, &a.UpdatedAt, &a.DeletedAt); err != nil {
		return nil, 0, err
	}
	return &a, seq, nil
}

// ---- projects ------------------------------------------------------------

const projectCols = `id, area_id, name, color, sort_order, archived_at, created_at, updated_at, deleted_at, version, server_seq`

var projectHandler = &entityHandler{
	typ:   protocol.EntityProject,
	table: "projects",
	upsert: func(s *Server, tx *sql.Tx, uid string, raw []byte, updatedAt time.Time, version, seq int64) error {
		var p domain.Project
		if err := json.Unmarshal(raw, &p); err != nil {
			return err
		}
		var deletedAt, archivedAt any
		if p.DeletedAt != nil {
			deletedAt = p.DeletedAt.UTC().Format(timeFormat)
		}
		if p.ArchivedAt != nil {
			archivedAt = p.ArchivedAt.UTC().Format(timeFormat)
		}
		_, err := tx.Exec(s.rebind(
			`INSERT INTO projects (id, user_id, area_id, name, color, sort_order, archived_at, created_at, updated_at, deleted_at, version, server_seq)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET
			   area_id = excluded.area_id, name = excluded.name, color = excluded.color,
			   sort_order = excluded.sort_order, archived_at = excluded.archived_at,
			   updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
			   version = excluded.version, server_seq = excluded.server_seq;`),
			p.ID, uid, p.AreaID, p.Name, p.Color, p.SortOrder, archivedAt,
			p.CreatedAt.UTC().Format(timeFormat), updatedAt.Format(timeFormat), deletedAt, version, seq)
		return err
	},
	loadRaw: func(s *Server, tx *sql.Tx, uid, id string) ([]byte, error) {
		row := tx.QueryRow(s.rebind(`SELECT `+projectCols+` FROM projects WHERE id = ? AND user_id = ?;`), id, uid)
		p, _, err := scanServerProject(row)
		if err != nil {
			return nil, err
		}
		return json.Marshal(p)
	},
	pull: func(s *Server, uid string, cursor, limit int64) ([]seqRow, error) {
		rows, err := s.query(`SELECT `+projectCols+` FROM projects WHERE user_id = ? AND server_seq > ? ORDER BY server_seq ASC LIMIT ?;`, uid, cursor, limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []seqRow
		for rows.Next() {
			p, seq, err := scanServerProject(rows)
			if err != nil {
				return nil, err
			}
			body, err := json.Marshal(p)
			if err != nil {
				return nil, err
			}
			out = append(out, seqRow{seq, protocol.PullChange{EntityType: protocol.EntityProject, Row: body, ServerSeq: seq}})
		}
		return out, rows.Err()
	},
}

func scanServerProject(sc rowScanner) (*domain.Project, int64, error) {
	var (
		p                            domain.Project
		color, deletedAt, archivedAt sql.NullString
		createdAt, updatedAt         string
		seq                          int64
	)
	if err := sc.Scan(&p.ID, &p.AreaID, &p.Name, &color, &p.SortOrder, &archivedAt, &createdAt, &updatedAt, &deletedAt, &p.Version, &seq); err != nil {
		return nil, 0, err
	}
	if color.Valid {
		p.Color = &color.String
	}
	if err := parseTimes(createdAt, updatedAt, deletedAt, &p.CreatedAt, &p.UpdatedAt, &p.DeletedAt); err != nil {
		return nil, 0, err
	}
	if archivedAt.Valid {
		t, err := time.Parse(timeFormat, archivedAt.String)
		if err != nil {
			return nil, 0, err
		}
		p.ArchivedAt = &t
	}
	return &p, seq, nil
}

// ---- project members -----------------------------------------------------

const memberCols = `id, project_id, entity_type, entity_id, created_at, updated_at, deleted_at, version, server_seq`

var memberHandler = &entityHandler{
	typ:   protocol.EntityProjectMember,
	table: "project_members",
	upsert: func(s *Server, tx *sql.Tx, uid string, raw []byte, updatedAt time.Time, version, seq int64) error {
		var m domain.ProjectMember
		if err := json.Unmarshal(raw, &m); err != nil {
			return err
		}
		var deletedAt any
		if m.DeletedAt != nil {
			deletedAt = m.DeletedAt.UTC().Format(timeFormat)
		}
		_, err := tx.Exec(s.rebind(
			`INSERT INTO project_members (id, user_id, project_id, entity_type, entity_id, created_at, updated_at, deleted_at, version, server_seq)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET
			   project_id = excluded.project_id, entity_type = excluded.entity_type,
			   entity_id = excluded.entity_id, updated_at = excluded.updated_at,
			   deleted_at = excluded.deleted_at, version = excluded.version,
			   server_seq = excluded.server_seq;`),
			m.ID, uid, m.ProjectID, m.EntityType, m.EntityID,
			m.CreatedAt.UTC().Format(timeFormat), updatedAt.Format(timeFormat), deletedAt, version, seq)
		return err
	},
	loadRaw: func(s *Server, tx *sql.Tx, uid, id string) ([]byte, error) {
		row := tx.QueryRow(s.rebind(`SELECT `+memberCols+` FROM project_members WHERE id = ? AND user_id = ?;`), id, uid)
		m, _, err := scanServerMember(row)
		if err != nil {
			return nil, err
		}
		return json.Marshal(m)
	},
	pull: func(s *Server, uid string, cursor, limit int64) ([]seqRow, error) {
		rows, err := s.query(`SELECT `+memberCols+` FROM project_members WHERE user_id = ? AND server_seq > ? ORDER BY server_seq ASC LIMIT ?;`, uid, cursor, limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []seqRow
		for rows.Next() {
			m, seq, err := scanServerMember(rows)
			if err != nil {
				return nil, err
			}
			body, err := json.Marshal(m)
			if err != nil {
				return nil, err
			}
			out = append(out, seqRow{seq, protocol.PullChange{EntityType: protocol.EntityProjectMember, Row: body, ServerSeq: seq}})
		}
		return out, rows.Err()
	},
}

func scanServerMember(sc rowScanner) (*domain.ProjectMember, int64, error) {
	var (
		m                    domain.ProjectMember
		deletedAt            sql.NullString
		createdAt, updatedAt string
		seq                  int64
	)
	if err := sc.Scan(&m.ID, &m.ProjectID, &m.EntityType, &m.EntityID, &createdAt, &updatedAt, &deletedAt, &m.Version, &seq); err != nil {
		return nil, 0, err
	}
	if err := parseTimes(createdAt, updatedAt, deletedAt, &m.CreatedAt, &m.UpdatedAt, &m.DeletedAt); err != nil {
		return nil, 0, err
	}
	return &m, seq, nil
}

// parseTimes parses the RFC3339 created_at/updated_at strings and the nullable
// deleted_at into their destinations — the boilerplate every scan shares.
func parseTimes(createdAt, updatedAt string, deletedAt sql.NullString, created, updated *time.Time, deleted **time.Time) error {
	var err error
	if *created, err = time.Parse(timeFormat, createdAt); err != nil {
		return err
	}
	if *updated, err = time.Parse(timeFormat, updatedAt); err != nil {
		return err
	}
	if deletedAt.Valid {
		t, err := time.Parse(timeFormat, deletedAt.String)
		if err != nil {
			return err
		}
		*deleted = &t
	}
	return nil
}
