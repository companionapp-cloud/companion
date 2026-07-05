package store

import (
	"database/sql"
	"fmt"
	"strings"

	"companion/core/domain"
)

// LinksRepo owns the derived link index (PLAN §5). It is written only as a side effect
// of entity writes (SyncSource / DeleteSource, called from the note repo on both local
// mutations and sync-apply) and read by the graph.* bridge methods. Because the table
// holds no user-authored data, Rebuild can reconstruct it from scratch at any time.
type LinksRepo struct {
	db Driver
}

// graphNodeColumns is the slim projection order used everywhere nodes are scanned.
const graphNodeColumns = `id, type, title, object_type_id, status`

// SyncSource replaces the outgoing links for one source with those parsed from its
// markdown. A plain replace (delete + insert) rather than a per-edge diff: the index is
// local and small, and the end state is identical. Not wrapped in a transaction —
// matching the store's per-write style (PLAN §5.1); a partial failure only leaves a
// stale index that graph.rebuild repairs.
func (r *LinksRepo) SyncSource(sourceType, sourceID, markdown string) error {
	if err := r.DeleteSource(sourceType, sourceID); err != nil {
		return err
	}
	refs := domain.ParseRefs(markdown)
	for _, ref := range refs {
		if _, err := r.db.Exec(
			`INSERT OR IGNORE INTO links
			   (source_type, source_id, target_type, target_id, kind)
			 VALUES (?, ?, ?, ?, ?);`,
			sourceType, sourceID, ref.TargetType, ref.TargetID, ref.Kind,
		); err != nil {
			return fmt.Errorf("insert link: %w", err)
		}
	}
	return nil
}

// AddEdge inserts one authored edge (kind 'member' or 'stack') into the index, keyed by
// its full tuple. Idempotent via the primary key. Unlike SyncSource, it targets a single
// edge so a project's other member edges are untouched (PLAN §5.1).
func (r *LinksRepo) AddEdge(sourceType, sourceID, targetType, targetID, kind string) error {
	if _, err := r.db.Exec(
		`INSERT OR IGNORE INTO links
		   (source_type, source_id, target_type, target_id, kind)
		 VALUES (?, ?, ?, ?, ?);`,
		sourceType, sourceID, targetType, targetID, kind,
	); err != nil {
		return fmt.Errorf("insert edge: %w", err)
	}
	return nil
}

// DeleteEdge removes one authored edge (used when a membership/stack row is tombstoned).
func (r *LinksRepo) DeleteEdge(sourceType, sourceID, targetType, targetID, kind string) error {
	if _, err := r.db.Exec(
		`DELETE FROM links WHERE source_type = ? AND source_id = ? AND target_type = ?
		   AND target_id = ? AND kind = ?;`,
		sourceType, sourceID, targetType, targetID, kind,
	); err != nil {
		return fmt.Errorf("delete edge: %w", err)
	}
	return nil
}

// DeleteSource removes every outgoing edge from a source (used when the source is
// tombstoned). Incoming edges are intentionally left to dangle (PLAN §5.1).
func (r *LinksRepo) DeleteSource(sourceType, sourceID string) error {
	if _, err := r.db.Exec(
		`DELETE FROM links WHERE source_type = ? AND source_id = ?;`, sourceType, sourceID,
	); err != nil {
		return fmt.Errorf("delete source links: %w", err)
	}
	return nil
}

// Full returns the entire graph: every node projection plus every edge. The payload is
// ids/titles/kinds only (no bodies), so this stays small even for the whole
// knowledgebase (PLAN §5.2).
func (r *LinksRepo) Full() (*domain.Graph, error) {
	nodes, err := r.queryNodes(`SELECT ` + graphNodeColumns + ` FROM graph_nodes;`)
	if err != nil {
		return nil, err
	}
	edges, err := r.queryEdges(
		`SELECT source_type, source_id, target_type, target_id, kind FROM links;`)
	if err != nil {
		return nil, err
	}
	return &domain.Graph{Nodes: nodes, Edges: edges}, nil
}

// Backlinks returns the source nodes that reference the given target (PLAN §5.2:
// "linked mentions"). Sources always resolve to a real node, so no ghost handling.
func (r *LinksRepo) Backlinks(nodeType, nodeID string) ([]domain.GraphNode, error) {
	return r.queryNodes(
		`SELECT n.id, n.type, n.title, n.object_type_id, n.status
		 FROM links l JOIN graph_nodes n
		   ON n.type = l.source_type AND n.id = l.source_id
		 WHERE l.target_type = ? AND l.target_id = ?;`,
		nodeType, nodeID)
}

// Neighborhood returns the subgraph reachable from a seed node within depth hops,
// traversing edges in both directions (a recursive CTE over the link index). Depth < 1
// is treated as 1. Only edges whose endpoints are both inside the reached set are
// returned; nodes absent from graph_nodes stay out (the UI ghosts them from edges).
func (r *LinksRepo) Neighborhood(nodeType, nodeID string, depth int) (*domain.Graph, error) {
	if depth < 1 {
		depth = 1
	}
	reached, err := r.reach(nodeType, nodeID, depth)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(reached))
	for k := range reached {
		ids = append(ids, k.id)
	}
	if len(ids) == 0 {
		return &domain.Graph{}, nil
	}
	in, args := placeholders(ids)

	nodeRows, err := r.queryNodes(
		`SELECT `+graphNodeColumns+` FROM graph_nodes WHERE id IN (`+in+`);`, args...)
	if err != nil {
		return nil, err
	}
	nodes := make([]domain.GraphNode, 0, len(nodeRows))
	for _, n := range nodeRows {
		if reached[nodeKey{n.Type, n.ID}] {
			nodes = append(nodes, n)
		}
	}

	edgeArgs := append(append([]any{}, args...), args...)
	edgeRows, err := r.queryEdges(
		`SELECT source_type, source_id, target_type, target_id, kind FROM links
		 WHERE source_id IN (`+in+`) OR target_id IN (`+in+`);`, edgeArgs...)
	if err != nil {
		return nil, err
	}
	edges := make([]domain.GraphEdge, 0, len(edgeRows))
	for _, e := range edgeRows {
		if reached[nodeKey{e.SourceType, e.SourceID}] && reached[nodeKey{e.TargetType, e.TargetID}] {
			edges = append(edges, e)
		}
	}
	return &domain.Graph{Nodes: nodes, Edges: edges}, nil
}

// Rebuild truncates the index and re-extracts links from every source that carries
// markdown (notes today; task notes_md is included so the index is correct the moment
// tasks land). Safe to run any time; returns the resulting counts.
func (r *LinksRepo) Rebuild() (nodeCount, edgeCount int, err error) {
	if _, err = r.db.Exec(`DELETE FROM links;`); err != nil {
		return 0, 0, fmt.Errorf("truncate links: %w", err)
	}
	if err = r.extractAll(`SELECT id, content_md FROM notes WHERE deleted_at IS NULL AND deleting_at IS NULL;`, domain.NodeNote); err != nil {
		return 0, 0, err
	}
	if err = r.extractAll(`SELECT id, notes_md FROM tasks WHERE deleted_at IS NULL AND deleting_at IS NULL;`, domain.NodeTask); err != nil {
		return 0, 0, err
	}
	// Re-mirror authored edges: project_members → 'member' edges (PLAN §5.1). Safe to
	// rebuild because the edges re-derive from their own synced table.
	if err = r.rebuildMemberEdges(); err != nil {
		return 0, 0, err
	}
	if nodeCount, err = r.count(`SELECT count(*) FROM graph_nodes;`); err != nil {
		return 0, 0, err
	}
	if edgeCount, err = r.count(`SELECT count(*) FROM links;`); err != nil {
		return 0, 0, err
	}
	return nodeCount, edgeCount, nil
}

// Search returns graph nodes whose title matches the query, capped at limit (default
// 20). An optional typ ("" or "all" means every type) scopes results to one entity type.
// Prefix matches rank above other substring matches, then shorter titles, then
// alphabetical. An empty query returns the first `limit` nodes by title. Powers the
// editor's wikilink autocomplete.
func (r *LinksRepo) Search(query, typ string, limit int) ([]domain.GraphNode, error) {
	if limit <= 0 {
		limit = 20
	}
	q := strings.TrimSpace(query)
	typ = strings.TrimSpace(typ)

	conds := make([]string, 0, 2)
	args := make([]any, 0, 4)
	if q != "" {
		conds = append(conds, `title LIKE ? ESCAPE '\'`)
		args = append(args, "%"+escapeLike(q)+"%")
	}
	if typ != "" && typ != "all" {
		conds = append(conds, `type = ?`)
		args = append(args, typ)
	}
	where := ""
	if len(conds) > 0 {
		where = "WHERE " + strings.Join(conds, " AND ") + " "
	}
	order := "ORDER BY title"
	if q != "" {
		order = `ORDER BY (title LIKE ? ESCAPE '\') DESC, length(title), title`
		args = append(args, escapeLike(q)+"%")
	}
	args = append(args, limit)
	return r.queryNodes(
		`SELECT `+graphNodeColumns+` FROM graph_nodes `+where+order+` LIMIT ?;`, args...)
}

// LookupNode resolves a single live node by id (any type), for turning a pasted UUID
// into a typed wikilink. Returns (nil, nil) when nothing matches.
func (r *LinksRepo) LookupNode(id string) (*domain.GraphNode, error) {
	nodes, err := r.queryNodes(
		`SELECT `+graphNodeColumns+` FROM graph_nodes WHERE id = ? LIMIT 1;`, id)
	if err != nil {
		return nil, err
	}
	if len(nodes) == 0 {
		return nil, nil
	}
	return &nodes[0], nil
}

// escapeLike escapes the LIKE wildcards in user input so a search for "50%" or "a_b"
// matches literally (paired with `ESCAPE '\'` in the query).
func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// count runs a scalar count query.
func (r *LinksRepo) count(query string) (int, error) {
	rows, err := r.db.Query(query)
	if err != nil {
		return 0, fmt.Errorf("count: %w", err)
	}
	defer rows.Close()
	var n int
	if rows.Next() {
		if err := rows.Scan(&n); err != nil {
			return 0, err
		}
	}
	return n, rows.Err()
}

// rebuildMemberEdges re-mirrors every live project membership as a 'member' edge
// (source project → target member entity). Used by Rebuild after truncating links.
func (r *LinksRepo) rebuildMemberEdges() error {
	rows, err := r.db.Query(
		`SELECT project_id, entity_type, entity_id FROM project_members WHERE deleted_at IS NULL;`)
	if err != nil {
		return fmt.Errorf("scan project_members: %w", err)
	}
	type edge struct{ projectID, entityType, entityID string }
	var batch []edge
	func() {
		defer rows.Close()
		for rows.Next() {
			var e edge
			if err = rows.Scan(&e.projectID, &e.entityType, &e.entityID); err != nil {
				return
			}
			batch = append(batch, e)
		}
		err = rows.Err()
	}()
	if err != nil {
		return err
	}
	for _, e := range batch {
		if err := r.AddEdge(domain.NodeProject, e.projectID, e.entityType, e.entityID, domain.KindMember); err != nil {
			return err
		}
	}
	return nil
}

// extractAll parses refs for every (id, markdown) row of a source query and replaces
// that source's links.
func (r *LinksRepo) extractAll(query, sourceType string) error {
	rows, err := r.db.Query(query)
	if err != nil {
		return fmt.Errorf("scan sources: %w", err)
	}
	type row struct{ id, md string }
	var batch []row
	func() {
		defer rows.Close()
		for rows.Next() {
			var id string
			var md sql.NullString
			if err = rows.Scan(&id, &md); err != nil {
				return
			}
			batch = append(batch, row{id, md.String})
		}
		err = rows.Err()
	}()
	if err != nil {
		return err
	}
	for _, b := range batch {
		if err := r.SyncSource(sourceType, b.id, b.md); err != nil {
			return err
		}
	}
	return nil
}

type nodeKey struct{ typ, id string }

// reach runs the bidirectional recursive traversal and returns the set of reached
// (type, id) keys.
func (r *LinksRepo) reach(nodeType, nodeID string, depth int) (map[nodeKey]bool, error) {
	rows, err := r.db.Query(
		`WITH RECURSIVE reach(type, id, depth) AS (
		   SELECT ?, ?, 0
		   UNION
		   SELECT nb.ntype, nb.nid, reach.depth + 1
		   FROM reach
		   JOIN (
		     SELECT source_type AS atype, source_id AS aid, target_type AS ntype, target_id AS nid FROM links
		     UNION
		     SELECT target_type AS atype, target_id AS aid, source_type AS ntype, source_id AS nid FROM links
		   ) nb ON nb.atype = reach.type AND nb.aid = reach.id
		   WHERE reach.depth < ?
		 )
		 SELECT DISTINCT type, id FROM reach;`,
		nodeType, nodeID, depth)
	if err != nil {
		return nil, fmt.Errorf("reach: %w", err)
	}
	defer rows.Close()
	set := map[nodeKey]bool{}
	for rows.Next() {
		var k nodeKey
		if err := rows.Scan(&k.typ, &k.id); err != nil {
			return nil, err
		}
		set[k] = true
	}
	return set, rows.Err()
}

func (r *LinksRepo) queryNodes(query string, args ...any) ([]domain.GraphNode, error) {
	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query nodes: %w", err)
	}
	defer rows.Close()
	out := []domain.GraphNode{}
	for rows.Next() {
		var n domain.GraphNode
		var objectTypeID, status sql.NullString
		if err := rows.Scan(&n.ID, &n.Type, &n.Title, &objectTypeID, &status); err != nil {
			return nil, fmt.Errorf("scan node: %w", err)
		}
		if objectTypeID.Valid {
			n.ObjectTypeID = &objectTypeID.String
		}
		if status.Valid {
			n.Status = &status.String
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

func (r *LinksRepo) queryEdges(query string, args ...any) ([]domain.GraphEdge, error) {
	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query edges: %w", err)
	}
	defer rows.Close()
	out := []domain.GraphEdge{}
	for rows.Next() {
		var e domain.GraphEdge
		if err := rows.Scan(&e.SourceType, &e.SourceID, &e.TargetType, &e.TargetID, &e.Kind); err != nil {
			return nil, fmt.Errorf("scan edge: %w", err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// placeholders builds an "?, ?, ..." fragment and the matching args slice for an IN
// clause.
func placeholders(ids []string) (string, []any) {
	marks := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		marks[i] = "?"
		args[i] = id
	}
	return strings.Join(marks, ", "), args
}
