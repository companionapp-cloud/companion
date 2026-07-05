-- Graph substrate (PLAN §4.0, §5). The `links` table is a DERIVED, local-only index
-- of edges extracted from synced content by core/domain.ParseRefs; it carries no sync
-- columns and can be truncated and rebuilt (graph.rebuild) at any time. `graph_nodes`
-- is a slim projection the graph view reads instead of entity bodies.

CREATE TABLE links (
  source_type TEXT NOT NULL,      -- 'note' | 'task' | 'habit' | 'project'
  source_id   TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,      -- 'ref' | 'embed' (authored 'stack'/'member' arrive later)
  PRIMARY KEY (source_type, source_id, target_type, target_id, kind)
);
CREATE INDEX idx_links_target ON links (target_type, target_id);  -- backlinks

-- Only the columns that exist today are projected. Later milestones DROP + recreate
-- this view to add projects (their table), object_type_id, and habit polarity.
CREATE VIEW graph_nodes AS
  SELECT id, 'note'  AS type, title, NULL AS object_type_id, NULL   AS status
    FROM notes  WHERE deleted_at IS NULL
  UNION ALL
  SELECT id, 'task'  AS type, title, NULL AS object_type_id, status AS status
    FROM tasks  WHERE deleted_at IS NULL
  UNION ALL
  SELECT id, 'habit' AS type, name,  NULL AS object_type_id, NULL   AS status
    FROM habits WHERE deleted_at IS NULL AND archived_at IS NULL;
