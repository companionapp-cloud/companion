package syncserver

import (
	"database/sql"
	"encoding/json"
	"time"

	"companion/core/domain"
	"companion/core/sync/protocol"
)

// Server SQL for notebooks (PLAN-notebooks.md): the book (trashable, like a canvas), its
// pages, and the ink on each page. Title, settings, page text and ink arrive as opaque
// envelope strings on an encrypted account and are stored verbatim; notebook_id stays a
// column on pages and ink so the Trash collector can take a purged book's contents with it.

// ---- notebooks ------------------------------------------------------------

const notebookCols = `id, title, cover_color, cover_document_id, settings_json, sort_order, created_at, updated_at, deleting_at, deleted_at, version, server_seq`

var notebookHandler = &entityHandler{
	typ:   protocol.EntityNotebook,
	table: "notebooks",
	upsert: func(s *Server, tx *sql.Tx, uid string, raw []byte, updatedAt time.Time, version, seq int64) error {
		var n domain.Notebook
		if err := json.Unmarshal(raw, &n); err != nil {
			return err
		}
		settings := string(n.Settings)
		if settings == "" || settings == "null" {
			settings = "{}"
		}
		color := n.CoverColor
		if color == "" {
			color = "ink"
		}
		_, err := tx.Exec(s.rebind(
			`INSERT INTO notebooks (id, user_id, title, cover_color, cover_document_id, settings_json, sort_order, created_at, updated_at, deleting_at, deleted_at, version, server_seq)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET
			   title = excluded.title, cover_color = excluded.cover_color, cover_document_id = excluded.cover_document_id,
			   settings_json = excluded.settings_json, sort_order = excluded.sort_order, updated_at = excluded.updated_at,
			   deleting_at = excluded.deleting_at, deleted_at = excluded.deleted_at, version = excluded.version, server_seq = excluded.server_seq;`),
			n.ID, uid, n.Title, color, nullStrPtr(n.CoverDocumentID), settings, n.SortOrder,
			n.CreatedAt.UTC().Format(timeFormat), updatedAt.Format(timeFormat),
			fmtTime(n.DeletingAt), fmtTime(n.DeletedAt), version, seq)
		return err
	},
	loadRaw: func(s *Server, tx *sql.Tx, uid, id string) ([]byte, error) {
		row := tx.QueryRow(s.rebind(`SELECT `+notebookCols+` FROM notebooks WHERE id = ? AND user_id = ?;`), id, uid)
		n, _, err := scanServerNotebook(row)
		if err != nil {
			return nil, err
		}
		return json.Marshal(n)
	},
	pull: func(s *Server, uid string, cursor, limit int64) ([]seqRow, error) {
		rows, err := s.query(`SELECT `+notebookCols+` FROM notebooks WHERE user_id = ? AND server_seq > ? ORDER BY server_seq ASC LIMIT ?;`, uid, cursor, limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []seqRow
		for rows.Next() {
			n, seq, err := scanServerNotebook(rows)
			if err != nil {
				return nil, err
			}
			body, err := json.Marshal(n)
			if err != nil {
				return nil, err
			}
			out = append(out, seqRow{seq, protocol.PullChange{EntityType: protocol.EntityNotebook, Row: body, ServerSeq: seq}})
		}
		return out, rows.Err()
	},
}

func scanServerNotebook(sc rowScanner) (*domain.Notebook, int64, error) {
	var (
		n                               domain.Notebook
		coverDoc, deletingAt, deletedAt sql.NullString
		settings, createdAt, updatedAt  string
		seq                             int64
	)
	if err := sc.Scan(&n.ID, &n.Title, &n.CoverColor, &coverDoc, &settings, &n.SortOrder, &createdAt, &updatedAt, &deletingAt, &deletedAt, &n.Version, &seq); err != nil {
		return nil, 0, err
	}
	if coverDoc.Valid {
		v := coverDoc.String
		n.CoverDocumentID = &v
	}
	if settings == "" {
		settings = "{}"
	}
	n.Settings = json.RawMessage(settings)
	if err := parseTimes(createdAt, updatedAt, deletedAt, &n.CreatedAt, &n.UpdatedAt, &n.DeletedAt); err != nil {
		return nil, 0, err
	}
	var err error
	if n.DeletingAt, err = parseServerTime(deletingAt); err != nil {
		return nil, 0, err
	}
	return &n, seq, nil
}

func nullStrPtr(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// ---- pages ----------------------------------------------------------------

const notebookPageCols = `id, notebook_id, sort_order, paper_kind, paper_spacing, content_md, created_at, updated_at, deleted_at, version, server_seq`

var notebookPageHandler = &entityHandler{
	typ:   protocol.EntityNotebookPage,
	table: "notebook_pages",
	upsert: func(s *Server, tx *sql.Tx, uid string, raw []byte, updatedAt time.Time, version, seq int64) error {
		var p domain.NotebookPage
		if err := json.Unmarshal(raw, &p); err != nil {
			return err
		}
		_, err := tx.Exec(s.rebind(
			`INSERT INTO notebook_pages (id, user_id, notebook_id, sort_order, paper_kind, paper_spacing, content_md, created_at, updated_at, deleted_at, version, server_seq)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET
			   notebook_id = excluded.notebook_id, sort_order = excluded.sort_order, paper_kind = excluded.paper_kind,
			   paper_spacing = excluded.paper_spacing, content_md = excluded.content_md, updated_at = excluded.updated_at,
			   deleted_at = excluded.deleted_at, version = excluded.version, server_seq = excluded.server_seq;`),
			p.ID, uid, p.NotebookID, p.SortOrder, p.PaperKind, p.PaperSpacing, p.ContentMD,
			p.CreatedAt.UTC().Format(timeFormat), updatedAt.Format(timeFormat), fmtTime(p.DeletedAt), version, seq)
		return err
	},
	loadRaw: func(s *Server, tx *sql.Tx, uid, id string) ([]byte, error) {
		row := tx.QueryRow(s.rebind(`SELECT `+notebookPageCols+` FROM notebook_pages WHERE id = ? AND user_id = ?;`), id, uid)
		p, _, err := scanServerNotebookPage(row)
		if err != nil {
			return nil, err
		}
		return json.Marshal(p)
	},
	pull: func(s *Server, uid string, cursor, limit int64) ([]seqRow, error) {
		rows, err := s.query(`SELECT `+notebookPageCols+` FROM notebook_pages WHERE user_id = ? AND server_seq > ? ORDER BY server_seq ASC LIMIT ?;`, uid, cursor, limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []seqRow
		for rows.Next() {
			p, seq, err := scanServerNotebookPage(rows)
			if err != nil {
				return nil, err
			}
			body, err := json.Marshal(p)
			if err != nil {
				return nil, err
			}
			out = append(out, seqRow{seq, protocol.PullChange{EntityType: protocol.EntityNotebookPage, Row: body, ServerSeq: seq}})
		}
		return out, rows.Err()
	},
}

func scanServerNotebookPage(sc rowScanner) (*domain.NotebookPage, int64, error) {
	var (
		p                    domain.NotebookPage
		deletedAt            sql.NullString
		createdAt, updatedAt string
		seq                  int64
	)
	if err := sc.Scan(&p.ID, &p.NotebookID, &p.SortOrder, &p.PaperKind, &p.PaperSpacing, &p.ContentMD, &createdAt, &updatedAt, &deletedAt, &p.Version, &seq); err != nil {
		return nil, 0, err
	}
	if err := parseTimes(createdAt, updatedAt, deletedAt, &p.CreatedAt, &p.UpdatedAt, &p.DeletedAt); err != nil {
		return nil, 0, err
	}
	return &p, seq, nil
}

// ---- ink ------------------------------------------------------------------

const notebookInkCols = `id, notebook_id, page_id, data_json, created_at, updated_at, deleted_at, version, server_seq`

var notebookInkHandler = &entityHandler{
	typ:   protocol.EntityNotebookPageInk,
	table: "notebook_page_ink",
	upsert: func(s *Server, tx *sql.Tx, uid string, raw []byte, updatedAt time.Time, version, seq int64) error {
		var g domain.NotebookPageInk
		if err := json.Unmarshal(raw, &g); err != nil {
			return err
		}
		data := string(g.Data)
		if data == "" || data == "null" {
			data = "{}"
		}
		_, err := tx.Exec(s.rebind(
			`INSERT INTO notebook_page_ink (id, user_id, notebook_id, page_id, data_json, created_at, updated_at, deleted_at, version, server_seq)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET
			   notebook_id = excluded.notebook_id, page_id = excluded.page_id, data_json = excluded.data_json,
			   updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, version = excluded.version, server_seq = excluded.server_seq;`),
			g.ID, uid, g.NotebookID, g.PageID, data, g.CreatedAt.UTC().Format(timeFormat), updatedAt.Format(timeFormat),
			fmtTime(g.DeletedAt), version, seq)
		return err
	},
	loadRaw: func(s *Server, tx *sql.Tx, uid, id string) ([]byte, error) {
		row := tx.QueryRow(s.rebind(`SELECT `+notebookInkCols+` FROM notebook_page_ink WHERE id = ? AND user_id = ?;`), id, uid)
		g, _, err := scanServerNotebookInk(row)
		if err != nil {
			return nil, err
		}
		return json.Marshal(g)
	},
	pull: func(s *Server, uid string, cursor, limit int64) ([]seqRow, error) {
		rows, err := s.query(`SELECT `+notebookInkCols+` FROM notebook_page_ink WHERE user_id = ? AND server_seq > ? ORDER BY server_seq ASC LIMIT ?;`, uid, cursor, limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []seqRow
		for rows.Next() {
			g, seq, err := scanServerNotebookInk(rows)
			if err != nil {
				return nil, err
			}
			body, err := json.Marshal(g)
			if err != nil {
				return nil, err
			}
			out = append(out, seqRow{seq, protocol.PullChange{EntityType: protocol.EntityNotebookPageInk, Row: body, ServerSeq: seq}})
		}
		return out, rows.Err()
	},
}

func scanServerNotebookInk(sc rowScanner) (*domain.NotebookPageInk, int64, error) {
	var (
		g                          domain.NotebookPageInk
		deletedAt                  sql.NullString
		data, createdAt, updatedAt string
		seq                        int64
	)
	if err := sc.Scan(&g.ID, &g.NotebookID, &g.PageID, &data, &createdAt, &updatedAt, &deletedAt, &g.Version, &seq); err != nil {
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
