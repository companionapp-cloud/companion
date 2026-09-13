package syncserver

import (
	"database/sql"
	"encoding/json"
	"time"

	"companion/core/domain"
	"companion/core/sync/protocol"
)

// Server SQL for the three canvas entities (PLAN-canvases.md): the board, its nodes, and
// its edges. Same shape as every other handler in server_entities.go: decode the wire row
// into its core/domain struct, upsert the business columns (preserving created_at), and
// scan rows back out for pull/conflict responses. Encrypted fields (name, data, label)
// arrive as opaque envelope strings and are stored verbatim.

// ---- canvases ------------------------------------------------------------

const canvasCols = `id, name, created_at, updated_at, deleting_at, deleted_at, version, server_seq`

var canvasHandler = &entityHandler{
	typ:   protocol.EntityCanvas,
	table: "canvases",
	upsert: func(s *Server, tx *sql.Tx, uid string, raw []byte, updatedAt time.Time, version, seq int64) error {
		var c domain.Canvas
		if err := json.Unmarshal(raw, &c); err != nil {
			return err
		}
		_, err := tx.Exec(s.rebind(
			`INSERT INTO canvases (id, user_id, name, created_at, updated_at, deleting_at, deleted_at, version, server_seq)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET
			   name = excluded.name, updated_at = excluded.updated_at, deleting_at = excluded.deleting_at,
			   deleted_at = excluded.deleted_at, version = excluded.version, server_seq = excluded.server_seq;`),
			c.ID, uid, c.Name, c.CreatedAt.UTC().Format(timeFormat), updatedAt.Format(timeFormat),
			fmtTime(c.DeletingAt), fmtTime(c.DeletedAt), version, seq)
		return err
	},
	loadRaw: func(s *Server, tx *sql.Tx, uid, id string) ([]byte, error) {
		row := tx.QueryRow(s.rebind(`SELECT `+canvasCols+` FROM canvases WHERE id = ? AND user_id = ?;`), id, uid)
		c, _, err := scanServerCanvas(row)
		if err != nil {
			return nil, err
		}
		return json.Marshal(c)
	},
	pull: func(s *Server, uid string, cursor, limit int64) ([]seqRow, error) {
		rows, err := s.query(`SELECT `+canvasCols+` FROM canvases WHERE user_id = ? AND server_seq > ? ORDER BY server_seq ASC LIMIT ?;`, uid, cursor, limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []seqRow
		for rows.Next() {
			c, seq, err := scanServerCanvas(rows)
			if err != nil {
				return nil, err
			}
			body, err := json.Marshal(c)
			if err != nil {
				return nil, err
			}
			out = append(out, seqRow{seq, protocol.PullChange{EntityType: protocol.EntityCanvas, Row: body, ServerSeq: seq}})
		}
		return out, rows.Err()
	},
}

func scanServerCanvas(sc rowScanner) (*domain.Canvas, int64, error) {
	var (
		c                     domain.Canvas
		deletingAt, deletedAt sql.NullString
		createdAt, updatedAt  string
		seq                   int64
	)
	if err := sc.Scan(&c.ID, &c.Name, &createdAt, &updatedAt, &deletingAt, &deletedAt, &c.Version, &seq); err != nil {
		return nil, 0, err
	}
	if err := parseTimes(createdAt, updatedAt, deletedAt, &c.CreatedAt, &c.UpdatedAt, &c.DeletedAt); err != nil {
		return nil, 0, err
	}
	var err error
	if c.DeletingAt, err = parseServerTime(deletingAt); err != nil {
		return nil, 0, err
	}
	return &c, seq, nil
}

// ---- canvas nodes --------------------------------------------------------

const canvasNodeCols = `id, canvas_id, kind, x, y, width, height, z, color, ref_type, ref_id, data_json, created_at, updated_at, deleted_at, version, server_seq`

var canvasNodeHandler = &entityHandler{
	typ:   protocol.EntityCanvasNode,
	table: "canvas_nodes",
	upsert: func(s *Server, tx *sql.Tx, uid string, raw []byte, updatedAt time.Time, version, seq int64) error {
		var n domain.CanvasNode
		if err := json.Unmarshal(raw, &n); err != nil {
			return err
		}
		data := string(n.Data)
		if data == "" || data == "null" {
			data = "{}"
		}
		_, err := tx.Exec(s.rebind(
			`INSERT INTO canvas_nodes (id, user_id, canvas_id, kind, x, y, width, height, z, color, ref_type, ref_id, data_json, created_at, updated_at, deleted_at, version, server_seq)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET
			   canvas_id = excluded.canvas_id, kind = excluded.kind, x = excluded.x, y = excluded.y,
			   width = excluded.width, height = excluded.height, z = excluded.z, color = excluded.color,
			   ref_type = excluded.ref_type, ref_id = excluded.ref_id, data_json = excluded.data_json,
			   updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
			   version = excluded.version, server_seq = excluded.server_seq;`),
			n.ID, uid, n.CanvasID, n.Kind, n.X, n.Y, n.Width, n.Height, n.Z, n.Color, n.RefType, n.RefID, data,
			n.CreatedAt.UTC().Format(timeFormat), updatedAt.Format(timeFormat), fmtTime(n.DeletedAt), version, seq)
		return err
	},
	loadRaw: func(s *Server, tx *sql.Tx, uid, id string) ([]byte, error) {
		row := tx.QueryRow(s.rebind(`SELECT `+canvasNodeCols+` FROM canvas_nodes WHERE id = ? AND user_id = ?;`), id, uid)
		n, _, err := scanServerCanvasNode(row)
		if err != nil {
			return nil, err
		}
		return json.Marshal(n)
	},
	pull: func(s *Server, uid string, cursor, limit int64) ([]seqRow, error) {
		rows, err := s.query(`SELECT `+canvasNodeCols+` FROM canvas_nodes WHERE user_id = ? AND server_seq > ? ORDER BY server_seq ASC LIMIT ?;`, uid, cursor, limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []seqRow
		for rows.Next() {
			n, seq, err := scanServerCanvasNode(rows)
			if err != nil {
				return nil, err
			}
			body, err := json.Marshal(n)
			if err != nil {
				return nil, err
			}
			out = append(out, seqRow{seq, protocol.PullChange{EntityType: protocol.EntityCanvasNode, Row: body, ServerSeq: seq}})
		}
		return out, rows.Err()
	},
}

func scanServerCanvasNode(sc rowScanner) (*domain.CanvasNode, int64, error) {
	var (
		n                                domain.CanvasNode
		color, refType, refID, deletedAt sql.NullString
		data, createdAt, updatedAt       string
		seq                              int64
	)
	if err := sc.Scan(&n.ID, &n.CanvasID, &n.Kind, &n.X, &n.Y, &n.Width, &n.Height, &n.Z, &color, &refType, &refID, &data, &createdAt, &updatedAt, &deletedAt, &n.Version, &seq); err != nil {
		return nil, 0, err
	}
	if color.Valid {
		n.Color = &color.String
	}
	if refType.Valid {
		n.RefType = &refType.String
	}
	if refID.Valid {
		n.RefID = &refID.String
	}
	if data == "" {
		data = "{}"
	}
	n.Data = json.RawMessage(data)
	if err := parseTimes(createdAt, updatedAt, deletedAt, &n.CreatedAt, &n.UpdatedAt, &n.DeletedAt); err != nil {
		return nil, 0, err
	}
	return &n, seq, nil
}

// ---- canvas edges --------------------------------------------------------

const canvasEdgeCols = `id, canvas_id, from_node_id, to_node_id, from_side, to_side, from_end, to_end, style, label, color, created_at, updated_at, deleted_at, version, server_seq`

var canvasEdgeHandler = &entityHandler{
	typ:   protocol.EntityCanvasEdge,
	table: "canvas_edges",
	upsert: func(s *Server, tx *sql.Tx, uid string, raw []byte, updatedAt time.Time, version, seq int64) error {
		var e domain.CanvasEdge
		if err := json.Unmarshal(raw, &e); err != nil {
			return err
		}
		_, err := tx.Exec(s.rebind(
			`INSERT INTO canvas_edges (id, user_id, canvas_id, from_node_id, to_node_id, from_side, to_side, from_end, to_end, style, label, color, created_at, updated_at, deleted_at, version, server_seq)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET
			   canvas_id = excluded.canvas_id, from_node_id = excluded.from_node_id, to_node_id = excluded.to_node_id,
			   from_side = excluded.from_side, to_side = excluded.to_side, from_end = excluded.from_end, to_end = excluded.to_end,
			   style = excluded.style, label = excluded.label, color = excluded.color, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
			   version = excluded.version, server_seq = excluded.server_seq;`),
			e.ID, uid, e.CanvasID, e.FromNodeID, e.ToNodeID, e.FromSide, e.ToSide, e.FromEnd, e.ToEnd, styleOrDefault(e.Style), e.Label, e.Color,
			e.CreatedAt.UTC().Format(timeFormat), updatedAt.Format(timeFormat), fmtTime(e.DeletedAt), version, seq)
		return err
	},
	loadRaw: func(s *Server, tx *sql.Tx, uid, id string) ([]byte, error) {
		row := tx.QueryRow(s.rebind(`SELECT `+canvasEdgeCols+` FROM canvas_edges WHERE id = ? AND user_id = ?;`), id, uid)
		e, _, err := scanServerCanvasEdge(row)
		if err != nil {
			return nil, err
		}
		return json.Marshal(e)
	},
	pull: func(s *Server, uid string, cursor, limit int64) ([]seqRow, error) {
		rows, err := s.query(`SELECT `+canvasEdgeCols+` FROM canvas_edges WHERE user_id = ? AND server_seq > ? ORDER BY server_seq ASC LIMIT ?;`, uid, cursor, limit)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []seqRow
		for rows.Next() {
			e, seq, err := scanServerCanvasEdge(rows)
			if err != nil {
				return nil, err
			}
			body, err := json.Marshal(e)
			if err != nil {
				return nil, err
			}
			out = append(out, seqRow{seq, protocol.PullChange{EntityType: protocol.EntityCanvasEdge, Row: body, ServerSeq: seq}})
		}
		return out, rows.Err()
	},
}

func scanServerCanvasEdge(sc rowScanner) (*domain.CanvasEdge, int64, error) {
	var (
		e                                  domain.CanvasEdge
		fromSide, toSide, color, deletedAt sql.NullString
		createdAt, updatedAt               string
		seq                                int64
	)
	if err := sc.Scan(&e.ID, &e.CanvasID, &e.FromNodeID, &e.ToNodeID, &fromSide, &toSide, &e.FromEnd, &e.ToEnd, &e.Style, &e.Label, &color, &createdAt, &updatedAt, &deletedAt, &e.Version, &seq); err != nil {
		return nil, 0, err
	}
	e.Style = styleOrDefault(e.Style)
	if fromSide.Valid {
		e.FromSide = &fromSide.String
	}
	if toSide.Valid {
		e.ToSide = &toSide.String
	}
	if color.Valid {
		e.Color = &color.String
	}
	if err := parseTimes(createdAt, updatedAt, deletedAt, &e.CreatedAt, &e.UpdatedAt, &e.DeletedAt); err != nil {
		return nil, 0, err
	}
	return &e, seq, nil
}

// styleOrDefault fills the curved default for edges pushed by devices predating the style
// column.
func styleOrDefault(style string) string {
	if style == "" {
		return "curved"
	}
	return style
}
