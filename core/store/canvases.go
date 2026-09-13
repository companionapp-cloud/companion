package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"companion/core/domain"
	"companion/core/sync/protocol"

	"github.com/google/uuid"
)

// Canvases (PLAN-canvases.md): three repos over three synced tables — the board
// (CanvasesRepo), its nodes (CanvasNodesRepo) and its edges (CanvasEdgesRepo). Nodes that
// embed a note/task/document mirror an authored 'canvas' edge into the link index on every
// write and sync-apply, exactly as project_members mirror 'member' edges, so backlinks and
// the graph see "on canvas X" without touching canvas rows.

// ---- canvases ------------------------------------------------------------------------

// CanvasesRepo owns the board rows.
type CanvasesRepo struct {
	db    Driver
	clock domain.Clock
	links *LinksRepo
}

const canvasColumns = `id, name, created_at, updated_at, deleting_at, deleted_at, version, dirty`

// CreateCanvasInput carries the client-supplied fields for a new canvas.
type CreateCanvasInput struct {
	Name string `json:"name"`
}

// UpdateCanvasInput carries partial updates; nil fields are left unchanged.
type UpdateCanvasInput struct {
	Name *string `json:"name,omitempty"`
}

// Create inserts a new canvas (UUIDv7 id, version 0, dirty).
func (r *CanvasesRepo) Create(in CreateCanvasInput) (*domain.Canvas, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return nil, fmt.Errorf("generate uuid: %w", err)
	}
	now := r.clock.Now().UTC()
	c := &domain.Canvas{ID: id.String(), Name: strings.TrimSpace(in.Name), CreatedAt: now, UpdatedAt: now, Version: 0, Dirty: true}
	if err := c.Validate(); err != nil {
		return nil, err
	}
	if _, err := r.db.Exec(
		`INSERT INTO canvases (id, name, created_at, updated_at, version, dirty) VALUES (?, ?, ?, ?, ?, ?);`,
		c.ID, c.Name, c.CreatedAt.Format(timeFormat), c.UpdatedAt.Format(timeFormat), c.Version, boolToInt(c.Dirty),
	); err != nil {
		return nil, fmt.Errorf("insert canvas: %w", err)
	}
	return c, nil
}

// Get returns a live canvas by id, or ErrNotFound.
func (r *CanvasesRepo) Get(id string) (*domain.Canvas, error) {
	rows, err := r.db.Query(`SELECT `+canvasColumns+` FROM canvases WHERE id = ? AND deleted_at IS NULL AND deleting_at IS NULL;`, id)
	if err != nil {
		return nil, fmt.Errorf("query canvas: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanCanvas(rows)
}

// List returns every live canvas, most recently updated first.
func (r *CanvasesRepo) List() ([]*domain.Canvas, error) {
	return r.list(`SELECT ` + canvasColumns + ` FROM canvases WHERE deleted_at IS NULL AND deleting_at IS NULL ORDER BY updated_at DESC, id;`)
}

// Update applies partial changes, bumps updated_at, marks dirty.
func (r *CanvasesRepo) Update(id string, in UpdateCanvasInput) (*domain.Canvas, error) {
	c, err := r.Get(id)
	if err != nil {
		return nil, err
	}
	if in.Name != nil {
		c.Name = strings.TrimSpace(*in.Name)
	}
	c.UpdatedAt = r.clock.Now().UTC()
	c.Dirty = true
	if _, err := r.db.Exec(`UPDATE canvases SET name = ?, updated_at = ?, dirty = 1 WHERE id = ?;`,
		c.Name, c.UpdatedAt.Format(timeFormat), c.ID); err != nil {
		return nil, fmt.Errorf("update canvas: %w", err)
	}
	return c, nil
}

// Touch bumps updated_at without marking the row dirty — used when a node/edge changes so
// "recently edited" ordering reflects board activity. The bump is local only: the board row
// itself has nothing new to push.
func (r *CanvasesRepo) Touch(id string) error {
	now := r.clock.Now().UTC()
	if _, err := r.db.Exec(`UPDATE canvases SET updated_at = ? WHERE id = ? AND deleted_at IS NULL;`, now.Format(timeFormat), id); err != nil {
		return fmt.Errorf("touch canvas: %w", err)
	}
	return nil
}

// Trash moves a canvas to the Trash (PLAN §4.3), hiding it from every query but ListTrash
// and dropping its outgoing graph edges. Nodes and edges are untouched: they follow the
// board and come back with it on Restore.
func (r *CanvasesRepo) Trash(id string) error {
	now := r.clock.Now().UTC()
	res, err := r.db.Exec(
		`UPDATE canvases SET deleting_at = ?, updated_at = ?, dirty = 1 WHERE id = ? AND deleted_at IS NULL AND deleting_at IS NULL;`,
		now.Add(TrashRetention).Format(timeFormat), now.Format(timeFormat), id)
	if err != nil {
		return fmt.Errorf("trash canvas: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	return r.links.DeleteSource(domain.NodeCanvas, id)
}

// TrashMany trashes several canvases in one statement (bulk delete); missing or
// already-trashed ids are skipped. Returns the number actually trashed.
func (r *CanvasesRepo) TrashMany(ids []string) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	now := r.clock.Now().UTC()
	in, idArgs := placeholders(ids)
	args := append([]any{now.Add(TrashRetention).Format(timeFormat), now.Format(timeFormat)}, idArgs...)
	res, err := r.db.Exec(
		`UPDATE canvases SET deleting_at = ?, updated_at = ?, dirty = 1 WHERE id IN (`+in+`) AND deleted_at IS NULL AND deleting_at IS NULL;`, args...)
	if err != nil {
		return 0, fmt.Errorf("trash canvases: %w", err)
	}
	affected, _ := res.RowsAffected()
	for _, id := range ids {
		if err := r.links.DeleteSource(domain.NodeCanvas, id); err != nil {
			return affected, err
		}
	}
	return affected, nil
}

// Restore brings a canvas back from the Trash or a tombstone and re-mirrors its node
// references into the link index.
func (r *CanvasesRepo) Restore(id string) error {
	c, err := r.GetAny(id)
	if err != nil {
		return err
	}
	if c.DeletedAt == nil && c.DeletingAt == nil {
		return ErrNotFound
	}
	now := r.clock.Now().UTC()
	if _, err := r.db.Exec(
		`UPDATE canvases SET deleting_at = NULL, deleted_at = NULL, updated_at = ?, dirty = 1 WHERE id = ?;`,
		now.Format(timeFormat), id); err != nil {
		return fmt.Errorf("restore canvas: %w", err)
	}
	return r.links.rebuildCanvasEdgesFor(id)
}

// ListTrash returns every trashed canvas, soonest to be purged first.
func (r *CanvasesRepo) ListTrash() ([]*domain.Canvas, error) {
	return r.list(`SELECT ` + canvasColumns + ` FROM canvases WHERE deleted_at IS NULL AND deleting_at IS NOT NULL ORDER BY deleting_at ASC, id ASC;`)
}

// Delete tombstones a canvas ("delete forever"). Callers tombstone its nodes and edges
// too (see the bridge) so they stop syncing.
func (r *CanvasesRepo) Delete(id string) error {
	now := r.clock.Now().UTC()
	res, err := r.db.Exec(`UPDATE canvases SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ? AND deleted_at IS NULL;`,
		now.Format(timeFormat), now.Format(timeFormat), id)
	if err != nil {
		return fmt.Errorf("delete canvas: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	return r.links.DeleteSource(domain.NodeCanvas, id)
}

func (r *CanvasesRepo) list(query string, args ...any) ([]*domain.Canvas, error) {
	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query canvases: %w", err)
	}
	defer rows.Close()
	out := []*domain.Canvas{}
	for rows.Next() {
		c, err := scanCanvas(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// --- SyncableRepo[*domain.Canvas] ---

func (r *CanvasesRepo) EntityType() string { return protocol.EntityCanvas }

func (r *CanvasesRepo) Dirty() ([]*domain.Canvas, error) {
	return r.list(`SELECT ` + canvasColumns + ` FROM canvases WHERE dirty = 1 ORDER BY updated_at ASC, id ASC;`)
}

func (r *CanvasesRepo) GetAny(id string) (*domain.Canvas, error) {
	rows, err := r.db.Query(`SELECT `+canvasColumns+` FROM canvases WHERE id = ?;`, id)
	if err != nil {
		return nil, fmt.Errorf("query canvas: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanCanvas(rows)
}

func (r *CanvasesRepo) Apply(c *domain.Canvas) error {
	if _, err := r.db.Exec(
		`INSERT INTO canvases (id, name, created_at, updated_at, deleting_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   name = excluded.name, created_at = excluded.created_at, updated_at = excluded.updated_at,
		   deleting_at = excluded.deleting_at, deleted_at = excluded.deleted_at,
		   version = excluded.version, dirty = 0;`,
		c.ID, c.Name, c.CreatedAt.UTC().Format(timeFormat), c.UpdatedAt.UTC().Format(timeFormat),
		fmtNullTime(c.DeletingAt), fmtNullTime(c.DeletedAt), c.Version,
	); err != nil {
		return fmt.Errorf("apply canvas: %w", err)
	}
	if c.DeletedAt != nil || c.DeletingAt != nil {
		return r.links.DeleteSource(domain.NodeCanvas, c.ID)
	}
	return r.links.rebuildCanvasEdgesFor(c.ID)
}

func (r *CanvasesRepo) MarkPushed(id string, version int64) error {
	if _, err := r.db.Exec(`UPDATE canvases SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark pushed: %w", err)
	}
	return nil
}

// MeaningfulDiff is always false: a board row carries only a name and trash state, and a
// forked "conflicted copy" would be an empty board — worse than adopting the server's
// name. Last-writer-wins converges.
func (r *CanvasesRepo) MeaningfulDiff(a, b *domain.Canvas) bool { return false }

// ConflictedCopy is a no-op (never invoked, since MeaningfulDiff is always false).
func (r *CanvasesRepo) ConflictedCopy(local *domain.Canvas, suffix string) error { return nil }

func (r *CanvasesRepo) Decode(raw json.RawMessage) (*domain.Canvas, error) {
	var c domain.Canvas
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("decode canvas: %w", err)
	}
	return &c, nil
}

func scanCanvas(rows Rows) (*domain.Canvas, error) {
	var (
		c                     domain.Canvas
		deletingAt, deletedAt sql.NullString
		createdAt, updatedAt  string
		dirty                 int
	)
	if err := rows.Scan(&c.ID, &c.Name, &createdAt, &updatedAt, &deletingAt, &deletedAt, &c.Version, &dirty); err != nil {
		return nil, fmt.Errorf("scan canvas: %w", err)
	}
	var err error
	if c.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if c.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	if c.DeletingAt, err = parseNullTime(deletingAt); err != nil {
		return nil, err
	}
	if c.DeletedAt, err = parseNullTime(deletedAt); err != nil {
		return nil, err
	}
	c.Dirty = dirty != 0
	return &c, nil
}

// ---- viewports (local-only) ----------------------------------------------------------

// CanvasView is the last viewport this device showed for a board; never synced.
type CanvasView struct {
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	Zoom float64 `json:"zoom"`
}

// GetView returns the saved viewport, or nil when the board has never been opened here.
func (r *CanvasesRepo) GetView(canvasID string) (*CanvasView, error) {
	rows, err := r.db.Query(`SELECT x, y, zoom FROM canvas_views WHERE canvas_id = ?;`, canvasID)
	if err != nil {
		return nil, fmt.Errorf("query canvas view: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	var v CanvasView
	if err := rows.Scan(&v.X, &v.Y, &v.Zoom); err != nil {
		return nil, fmt.Errorf("scan canvas view: %w", err)
	}
	return &v, nil
}

// SetView upserts the saved viewport.
func (r *CanvasesRepo) SetView(canvasID string, v CanvasView) error {
	if _, err := r.db.Exec(
		`INSERT INTO canvas_views (canvas_id, x, y, zoom) VALUES (?, ?, ?, ?)
		 ON CONFLICT(canvas_id) DO UPDATE SET x = excluded.x, y = excluded.y, zoom = excluded.zoom;`,
		canvasID, v.X, v.Y, v.Zoom); err != nil {
		return fmt.Errorf("set canvas view: %w", err)
	}
	return nil
}

// ---- nodes ---------------------------------------------------------------------------

// CanvasNodesRepo owns the items on a board.
type CanvasNodesRepo struct {
	db    Driver
	clock domain.Clock
	links *LinksRepo
}

const canvasNodeColumns = `id, canvas_id, kind, x, y, width, height, z, color, ref_type, ref_id, data_json, created_at, updated_at, deleted_at, version, dirty`

// CanvasNodeInput is the full shape of a node as the UI writes it. An empty ID creates a
// node; a known ID overwrites it (the client holds the whole node, so writes are whole).
type CanvasNodeInput struct {
	ID      string          `json:"id,omitempty"`
	Kind    string          `json:"kind"`
	X       float64         `json:"x"`
	Y       float64         `json:"y"`
	Width   float64         `json:"width"`
	Height  float64         `json:"height"`
	Z       int             `json:"z"`
	Color   *string         `json:"color,omitempty"`
	RefType *string         `json:"refType,omitempty"`
	RefID   *string         `json:"refId,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
}

// UpsertMany creates or overwrites a batch of nodes on one canvas, returning the
// resulting rows in input order. Reference edges are re-mirrored for every touched ref.
func (r *CanvasNodesRepo) UpsertMany(canvasID string, inputs []CanvasNodeInput) ([]*domain.CanvasNode, error) {
	now := r.clock.Now().UTC()
	out := make([]*domain.CanvasNode, 0, len(inputs))
	for _, in := range inputs {
		n := &domain.CanvasNode{
			ID: in.ID, CanvasID: canvasID, Kind: in.Kind, X: in.X, Y: in.Y, Width: in.Width, Height: in.Height,
			Z: in.Z, Color: in.Color, RefType: in.RefType, RefID: in.RefID, Data: json.RawMessage(normalizeProps(in.Data)),
			CreatedAt: now, UpdatedAt: now, Version: 0, Dirty: true,
		}
		var prev *domain.CanvasNode
		if n.ID == "" {
			id, err := uuid.NewV7()
			if err != nil {
				return nil, fmt.Errorf("generate uuid: %w", err)
			}
			n.ID = id.String()
		} else if existing, err := r.GetAny(n.ID); err == nil {
			if existing.CanvasID != canvasID {
				return nil, errors.Join(domain.ErrInvalidCanvas, errors.New("node belongs to another canvas"))
			}
			prev = existing
			n.CreatedAt = existing.CreatedAt
			n.Version = existing.Version
		} else if !errors.Is(err, ErrNotFound) {
			return nil, err
		}
		if err := n.Validate(); err != nil {
			return nil, err
		}
		if _, err := r.db.Exec(
			`INSERT INTO canvas_nodes (id, canvas_id, kind, x, y, width, height, z, color, ref_type, ref_id, data_json, created_at, updated_at, deleted_at, version, dirty)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1)
			 ON CONFLICT(id) DO UPDATE SET
			   kind = excluded.kind, x = excluded.x, y = excluded.y, width = excluded.width, height = excluded.height,
			   z = excluded.z, color = excluded.color, ref_type = excluded.ref_type, ref_id = excluded.ref_id,
			   data_json = excluded.data_json, updated_at = excluded.updated_at, deleted_at = NULL, dirty = 1;`,
			n.ID, n.CanvasID, n.Kind, n.X, n.Y, n.Width, n.Height, n.Z, n.Color, n.RefType, n.RefID, string(n.Data),
			n.CreatedAt.Format(timeFormat), n.UpdatedAt.Format(timeFormat), n.Version,
		); err != nil {
			return nil, fmt.Errorf("upsert canvas node: %w", err)
		}
		if prev != nil {
			if err := r.links.syncCanvasRef(canvasID, prev.RefType, prev.RefID); err != nil {
				return nil, err
			}
		}
		if err := r.links.syncCanvasRef(canvasID, n.RefType, n.RefID); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, nil
}

// Get returns a live node by id, or ErrNotFound.
func (r *CanvasNodesRepo) Get(id string) (*domain.CanvasNode, error) {
	rows, err := r.db.Query(`SELECT `+canvasNodeColumns+` FROM canvas_nodes WHERE id = ? AND deleted_at IS NULL;`, id)
	if err != nil {
		return nil, fmt.Errorf("query canvas node: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanCanvasNode(rows)
}

// ListForCanvas returns a board's live nodes, back-to-front (z, then creation order).
func (r *CanvasNodesRepo) ListForCanvas(canvasID string) ([]*domain.CanvasNode, error) {
	return r.list(`SELECT `+canvasNodeColumns+` FROM canvas_nodes WHERE canvas_id = ? AND deleted_at IS NULL ORDER BY z, created_at, id;`, canvasID)
}

// DeleteMany tombstones nodes (marking them dirty so the deletes sync) and drops any
// reference edges no other live node on the board still carries. Returns the count.
func (r *CanvasNodesRepo) DeleteMany(ids []string) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	in, idArgs := placeholders(ids)
	victims, err := r.list(`SELECT `+canvasNodeColumns+` FROM canvas_nodes WHERE id IN (`+in+`) AND deleted_at IS NULL;`, idArgs...)
	if err != nil {
		return 0, err
	}
	if len(victims) == 0 {
		return 0, nil
	}
	now := r.clock.Now().UTC().Format(timeFormat)
	args := append([]any{now, now}, idArgs...)
	res, err := r.db.Exec(`UPDATE canvas_nodes SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id IN (`+in+`) AND deleted_at IS NULL;`, args...)
	if err != nil {
		return 0, fmt.Errorf("delete canvas nodes: %w", err)
	}
	affected, _ := res.RowsAffected()
	for _, v := range victims {
		if err := r.links.syncCanvasRef(v.CanvasID, v.RefType, v.RefID); err != nil {
			return affected, err
		}
	}
	return affected, nil
}

// DeleteForCanvas tombstones every live node of a board (used when the board is purged).
func (r *CanvasNodesRepo) DeleteForCanvas(canvasID string) error {
	nodes, err := r.ListForCanvas(canvasID)
	if err != nil {
		return err
	}
	ids := make([]string, len(nodes))
	for i, n := range nodes {
		ids[i] = n.ID
	}
	_, err = r.DeleteMany(ids)
	return err
}

// CanvasIDsReferencing returns the ids of live boards that embed an entity — the
// "on canvas" backlink lookup, sourced from rows rather than the derived index.
func (r *CanvasNodesRepo) CanvasIDsReferencing(refType, refID string) ([]string, error) {
	rows, err := r.db.Query(
		`SELECT DISTINCT n.canvas_id FROM canvas_nodes n JOIN canvases c ON c.id = n.canvas_id
		 WHERE n.ref_type = ? AND n.ref_id = ? AND n.deleted_at IS NULL AND c.deleted_at IS NULL AND c.deleting_at IS NULL;`, refType, refID)
	if err != nil {
		return nil, fmt.Errorf("query referencing canvases: %w", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (r *CanvasNodesRepo) list(query string, args ...any) ([]*domain.CanvasNode, error) {
	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query canvas nodes: %w", err)
	}
	defer rows.Close()
	out := []*domain.CanvasNode{}
	for rows.Next() {
		n, err := scanCanvasNode(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// --- SyncableRepo[*domain.CanvasNode] ---

func (r *CanvasNodesRepo) EntityType() string { return protocol.EntityCanvasNode }

func (r *CanvasNodesRepo) Dirty() ([]*domain.CanvasNode, error) {
	return r.list(`SELECT ` + canvasNodeColumns + ` FROM canvas_nodes WHERE dirty = 1 ORDER BY updated_at ASC, id ASC;`)
}

func (r *CanvasNodesRepo) GetAny(id string) (*domain.CanvasNode, error) {
	rows, err := r.db.Query(`SELECT `+canvasNodeColumns+` FROM canvas_nodes WHERE id = ?;`, id)
	if err != nil {
		return nil, fmt.Errorf("query canvas node: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanCanvasNode(rows)
}

func (r *CanvasNodesRepo) Apply(n *domain.CanvasNode) error {
	prev, err := r.GetAny(n.ID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	if _, err := r.db.Exec(
		`INSERT INTO canvas_nodes (id, canvas_id, kind, x, y, width, height, z, color, ref_type, ref_id, data_json, created_at, updated_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   canvas_id = excluded.canvas_id, kind = excluded.kind, x = excluded.x, y = excluded.y,
		   width = excluded.width, height = excluded.height, z = excluded.z, color = excluded.color,
		   ref_type = excluded.ref_type, ref_id = excluded.ref_id, data_json = excluded.data_json,
		   created_at = excluded.created_at, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
		   version = excluded.version, dirty = 0;`,
		n.ID, n.CanvasID, n.Kind, n.X, n.Y, n.Width, n.Height, n.Z, n.Color, n.RefType, n.RefID, normalizeProps(n.Data),
		n.CreatedAt.UTC().Format(timeFormat), n.UpdatedAt.UTC().Format(timeFormat), fmtNullTime(n.DeletedAt), n.Version,
	); err != nil {
		return fmt.Errorf("apply canvas node: %w", err)
	}
	// Mirror the authored edge to match the applied state (PLAN §5.1): the old ref (if it
	// changed) and the new one are both reconciled against the board's live nodes.
	if prev != nil {
		if err := r.links.syncCanvasRef(prev.CanvasID, prev.RefType, prev.RefID); err != nil {
			return err
		}
	}
	return r.links.syncCanvasRef(n.CanvasID, n.RefType, n.RefID)
}

func (r *CanvasNodesRepo) MarkPushed(id string, version int64) error {
	if _, err := r.db.Exec(`UPDATE canvas_nodes SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark pushed: %w", err)
	}
	return nil
}

// MeaningfulDiff is always false: positions churn constantly and a forked sticky would be
// noise, so a concurrent edit of the same node is last-writer-wins (PLAN-canvases.md §0).
func (r *CanvasNodesRepo) MeaningfulDiff(a, b *domain.CanvasNode) bool { return false }

// ConflictedCopy is a no-op (never invoked, since MeaningfulDiff is always false).
func (r *CanvasNodesRepo) ConflictedCopy(local *domain.CanvasNode, suffix string) error { return nil }

func (r *CanvasNodesRepo) Decode(raw json.RawMessage) (*domain.CanvasNode, error) {
	var n domain.CanvasNode
	if err := json.Unmarshal(raw, &n); err != nil {
		return nil, fmt.Errorf("decode canvas node: %w", err)
	}
	return &n, nil
}

func scanCanvasNode(rows Rows) (*domain.CanvasNode, error) {
	var (
		n                                domain.CanvasNode
		color, refType, refID, deletedAt sql.NullString
		data, createdAt, updatedAt       string
		dirty                            int
	)
	if err := rows.Scan(&n.ID, &n.CanvasID, &n.Kind, &n.X, &n.Y, &n.Width, &n.Height, &n.Z, &color, &refType, &refID, &data, &createdAt, &updatedAt, &deletedAt, &n.Version, &dirty); err != nil {
		return nil, fmt.Errorf("scan canvas node: %w", err)
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
	n.Data = json.RawMessage(normalizeProps(json.RawMessage(data)))
	var err error
	if n.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if n.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	if n.DeletedAt, err = parseNullTime(deletedAt); err != nil {
		return nil, err
	}
	n.Dirty = dirty != 0
	return &n, nil
}

// ---- edges ---------------------------------------------------------------------------

// CanvasEdgesRepo owns the connectors between a board's nodes.
type CanvasEdgesRepo struct {
	db    Driver
	clock domain.Clock
}

const canvasEdgeColumns = `id, canvas_id, from_node_id, to_node_id, from_side, to_side, from_end, to_end, style, label, color, created_at, updated_at, deleted_at, version, dirty`

// CanvasEdgeInput is the full shape of an edge as the UI writes it (empty ID creates).
type CanvasEdgeInput struct {
	ID         string  `json:"id,omitempty"`
	FromNodeID string  `json:"fromNodeId"`
	ToNodeID   string  `json:"toNodeId"`
	FromSide   *string `json:"fromSide,omitempty"`
	ToSide     *string `json:"toSide,omitempty"`
	FromEnd    string  `json:"fromEnd"`
	ToEnd      string  `json:"toEnd"`
	Style      string  `json:"style"`
	Label      string  `json:"label"`
	Color      *string `json:"color,omitempty"`
}

// UpsertMany creates or overwrites a batch of edges on one canvas, in input order.
func (r *CanvasEdgesRepo) UpsertMany(canvasID string, inputs []CanvasEdgeInput) ([]*domain.CanvasEdge, error) {
	now := r.clock.Now().UTC()
	out := make([]*domain.CanvasEdge, 0, len(inputs))
	for _, in := range inputs {
		e := &domain.CanvasEdge{
			ID: in.ID, CanvasID: canvasID, FromNodeID: in.FromNodeID, ToNodeID: in.ToNodeID,
			FromSide: in.FromSide, ToSide: in.ToSide, FromEnd: in.FromEnd, ToEnd: in.ToEnd, Style: in.Style, Label: in.Label, Color: in.Color,
			CreatedAt: now, UpdatedAt: now, Version: 0, Dirty: true,
		}
		if e.FromEnd == "" {
			e.FromEnd = domain.CanvasEndNone
		}
		if e.ToEnd == "" {
			e.ToEnd = domain.CanvasEndArrow
		}
		if e.Style == "" {
			e.Style = domain.CanvasStyleCurved
		}
		if e.ID == "" {
			id, err := uuid.NewV7()
			if err != nil {
				return nil, fmt.Errorf("generate uuid: %w", err)
			}
			e.ID = id.String()
		} else if existing, err := r.GetAny(e.ID); err == nil {
			if existing.CanvasID != canvasID {
				return nil, errors.Join(domain.ErrInvalidCanvas, errors.New("edge belongs to another canvas"))
			}
			e.CreatedAt = existing.CreatedAt
			e.Version = existing.Version
		} else if !errors.Is(err, ErrNotFound) {
			return nil, err
		}
		if err := e.Validate(); err != nil {
			return nil, err
		}
		if _, err := r.db.Exec(
			`INSERT INTO canvas_edges (id, canvas_id, from_node_id, to_node_id, from_side, to_side, from_end, to_end, style, label, color, created_at, updated_at, deleted_at, version, dirty)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1)
			 ON CONFLICT(id) DO UPDATE SET
			   from_node_id = excluded.from_node_id, to_node_id = excluded.to_node_id, from_side = excluded.from_side,
			   to_side = excluded.to_side, from_end = excluded.from_end, to_end = excluded.to_end, style = excluded.style, label = excluded.label,
			   color = excluded.color, updated_at = excluded.updated_at, deleted_at = NULL, dirty = 1;`,
			e.ID, e.CanvasID, e.FromNodeID, e.ToNodeID, e.FromSide, e.ToSide, e.FromEnd, e.ToEnd, e.Style, e.Label, e.Color,
			e.CreatedAt.Format(timeFormat), e.UpdatedAt.Format(timeFormat), e.Version,
		); err != nil {
			return nil, fmt.Errorf("upsert canvas edge: %w", err)
		}
		out = append(out, e)
	}
	return out, nil
}

// ListForCanvas returns a board's live edges in creation order.
func (r *CanvasEdgesRepo) ListForCanvas(canvasID string) ([]*domain.CanvasEdge, error) {
	return r.list(`SELECT `+canvasEdgeColumns+` FROM canvas_edges WHERE canvas_id = ? AND deleted_at IS NULL ORDER BY created_at, id;`, canvasID)
}

// DeleteMany tombstones edges (dirty, so the deletes sync). Returns the count.
func (r *CanvasEdgesRepo) DeleteMany(ids []string) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	now := r.clock.Now().UTC().Format(timeFormat)
	in, idArgs := placeholders(ids)
	args := append([]any{now, now}, idArgs...)
	res, err := r.db.Exec(`UPDATE canvas_edges SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id IN (`+in+`) AND deleted_at IS NULL;`, args...)
	if err != nil {
		return 0, fmt.Errorf("delete canvas edges: %w", err)
	}
	affected, _ := res.RowsAffected()
	return affected, nil
}

// DeleteForNodes tombstones every live edge touching any of the given nodes (cascade
// from a node delete). Returns the ids it removed so the UI can drop them.
func (r *CanvasEdgesRepo) DeleteForNodes(nodeIDs []string) ([]string, error) {
	if len(nodeIDs) == 0 {
		return nil, nil
	}
	in, idArgs := placeholders(nodeIDs)
	args := append(append([]any{}, idArgs...), idArgs...)
	edges, err := r.list(`SELECT `+canvasEdgeColumns+` FROM canvas_edges WHERE deleted_at IS NULL AND (from_node_id IN (`+in+`) OR to_node_id IN (`+in+`));`, args...)
	if err != nil {
		return nil, err
	}
	ids := make([]string, len(edges))
	for i, e := range edges {
		ids[i] = e.ID
	}
	if _, err := r.DeleteMany(ids); err != nil {
		return nil, err
	}
	return ids, nil
}

// DeleteForCanvas tombstones every live edge of a board (used when the board is purged).
func (r *CanvasEdgesRepo) DeleteForCanvas(canvasID string) error {
	edges, err := r.ListForCanvas(canvasID)
	if err != nil {
		return err
	}
	ids := make([]string, len(edges))
	for i, e := range edges {
		ids[i] = e.ID
	}
	_, err = r.DeleteMany(ids)
	return err
}

func (r *CanvasEdgesRepo) list(query string, args ...any) ([]*domain.CanvasEdge, error) {
	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query canvas edges: %w", err)
	}
	defer rows.Close()
	out := []*domain.CanvasEdge{}
	for rows.Next() {
		e, err := scanCanvasEdge(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// --- SyncableRepo[*domain.CanvasEdge] ---

func (r *CanvasEdgesRepo) EntityType() string { return protocol.EntityCanvasEdge }

func (r *CanvasEdgesRepo) Dirty() ([]*domain.CanvasEdge, error) {
	return r.list(`SELECT ` + canvasEdgeColumns + ` FROM canvas_edges WHERE dirty = 1 ORDER BY updated_at ASC, id ASC;`)
}

func (r *CanvasEdgesRepo) GetAny(id string) (*domain.CanvasEdge, error) {
	rows, err := r.db.Query(`SELECT `+canvasEdgeColumns+` FROM canvas_edges WHERE id = ?;`, id)
	if err != nil {
		return nil, fmt.Errorf("query canvas edge: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanCanvasEdge(rows)
}

func (r *CanvasEdgesRepo) Apply(e *domain.CanvasEdge) error {
	if _, err := r.db.Exec(
		`INSERT INTO canvas_edges (id, canvas_id, from_node_id, to_node_id, from_side, to_side, from_end, to_end, style, label, color, created_at, updated_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   canvas_id = excluded.canvas_id, from_node_id = excluded.from_node_id, to_node_id = excluded.to_node_id,
		   from_side = excluded.from_side, to_side = excluded.to_side, from_end = excluded.from_end, to_end = excluded.to_end,
		   style = excluded.style, label = excluded.label, color = excluded.color, created_at = excluded.created_at, updated_at = excluded.updated_at,
		   deleted_at = excluded.deleted_at, version = excluded.version, dirty = 0;`,
		e.ID, e.CanvasID, e.FromNodeID, e.ToNodeID, e.FromSide, e.ToSide, e.FromEnd, e.ToEnd, normalizeEdgeStyle(e.Style), e.Label, e.Color,
		e.CreatedAt.UTC().Format(timeFormat), e.UpdatedAt.UTC().Format(timeFormat), fmtNullTime(e.DeletedAt), e.Version,
	); err != nil {
		return fmt.Errorf("apply canvas edge: %w", err)
	}
	return nil
}

func (r *CanvasEdgesRepo) MarkPushed(id string, version int64) error {
	if _, err := r.db.Exec(`UPDATE canvas_edges SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark pushed: %w", err)
	}
	return nil
}

// MeaningfulDiff is always false (last-writer-wins, as for nodes).
func (r *CanvasEdgesRepo) MeaningfulDiff(a, b *domain.CanvasEdge) bool { return false }

// ConflictedCopy is a no-op (never invoked, since MeaningfulDiff is always false).
func (r *CanvasEdgesRepo) ConflictedCopy(local *domain.CanvasEdge, suffix string) error { return nil }

func (r *CanvasEdgesRepo) Decode(raw json.RawMessage) (*domain.CanvasEdge, error) {
	var e domain.CanvasEdge
	if err := json.Unmarshal(raw, &e); err != nil {
		return nil, fmt.Errorf("decode canvas edge: %w", err)
	}
	return &e, nil
}

func scanCanvasEdge(rows Rows) (*domain.CanvasEdge, error) {
	var (
		e                                  domain.CanvasEdge
		fromSide, toSide, color, deletedAt sql.NullString
		createdAt, updatedAt               string
		dirty                              int
	)
	if err := rows.Scan(&e.ID, &e.CanvasID, &e.FromNodeID, &e.ToNodeID, &fromSide, &toSide, &e.FromEnd, &e.ToEnd, &e.Style, &e.Label, &color, &createdAt, &updatedAt, &deletedAt, &e.Version, &dirty); err != nil {
		return nil, fmt.Errorf("scan canvas edge: %w", err)
	}
	e.Style = normalizeEdgeStyle(e.Style)
	if fromSide.Valid {
		e.FromSide = &fromSide.String
	}
	if toSide.Valid {
		e.ToSide = &toSide.String
	}
	if color.Valid {
		e.Color = &color.String
	}
	var err error
	if e.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if e.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	if e.DeletedAt, err = parseNullTime(deletedAt); err != nil {
		return nil, err
	}
	e.Dirty = dirty != 0
	return &e, nil
}

// ---- helpers -------------------------------------------------------------------------

// fmtNullTime binds a nullable timestamp (or NULL).
func fmtNullTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UTC().Format(timeFormat)
}

// normalizeEdgeStyle defaults a missing line style (rows from before the column existed,
// or older devices) to the curved default.
func normalizeEdgeStyle(style string) string {
	if style == "" {
		return domain.CanvasStyleCurved
	}
	return style
}
