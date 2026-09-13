-- Canvases (PLAN-canvases.md): infinite 2D boards holding sticky text, groups, embedded
-- notes/tasks/events/images, link previews, and arrows between them. Three synced tables
-- (board / nodes / edges) so concurrent edits of different nodes merge per row. A board is
-- trashable like a note; nodes and edges follow their board and tombstone directly.
-- Coordinates are absolute canvas units, top-left origin. Groups own no children —
-- containment is geometric — so there is deliberately no parent_id column.

CREATE TABLE canvases (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleting_at TEXT,                            -- Trash (PLAN §4.3)
  deleted_at  TEXT,
  version     INTEGER NOT NULL DEFAULT 0,
  dirty       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE canvas_nodes (
  id         TEXT PRIMARY KEY,
  canvas_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,                    -- text | group | note | task | event | image | link
  x          REAL NOT NULL DEFAULT 0,
  y          REAL NOT NULL DEFAULT 0,
  width      REAL NOT NULL DEFAULT 200,
  height     REAL NOT NULL DEFAULT 100,
  z          INTEGER NOT NULL DEFAULT 0,
  color      TEXT,
  ref_type   TEXT,                             -- note | task | event | document (reference kinds)
  ref_id     TEXT,
  data_json  TEXT NOT NULL DEFAULT '{}',       -- kind-specific content; encrypted on the wire
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version    INTEGER NOT NULL DEFAULT 0,
  dirty      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_canvas_nodes_canvas ON canvas_nodes (canvas_id);
CREATE INDEX idx_canvas_nodes_ref    ON canvas_nodes (ref_type, ref_id);

CREATE TABLE canvas_edges (
  id           TEXT PRIMARY KEY,
  canvas_id    TEXT NOT NULL,
  from_node_id TEXT NOT NULL,
  to_node_id   TEXT NOT NULL,
  from_side    TEXT,                           -- top | right | bottom | left | NULL = auto
  to_side      TEXT,
  from_end     TEXT NOT NULL DEFAULT 'none',   -- none | arrow
  to_end       TEXT NOT NULL DEFAULT 'arrow',
  label        TEXT NOT NULL DEFAULT '',       -- encrypted on the wire
  color        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  version      INTEGER NOT NULL DEFAULT 0,
  dirty        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_canvas_edges_canvas ON canvas_edges (canvas_id);

-- Local-only (never synced): the last viewport this device showed for each board.
CREATE TABLE canvas_views (
  canvas_id TEXT PRIMARY KEY,
  x         REAL NOT NULL DEFAULT 0,
  y         REAL NOT NULL DEFAULT 0,
  zoom      REAL NOT NULL DEFAULT 1
);

-- Canvases are graph nodes: a board's embedded notes/tasks/images mirror into `links` as
-- authored 'canvas' edges, so backlinks show "on canvas X". Recreate the view with a
-- canvas branch (same pattern as 0011_documents.sql).
DROP VIEW graph_nodes;
CREATE VIEW graph_nodes AS
  SELECT id, 'note'     AS type, title,    object_type_id, NULL    AS status
    FROM notes     WHERE deleted_at IS NULL AND deleting_at IS NULL
  UNION ALL
  SELECT id, 'task'     AS type, title,    object_type_id, status  AS status
    FROM tasks     WHERE deleted_at IS NULL AND deleting_at IS NULL
  UNION ALL
  SELECT id, 'habit'    AS type, name,     NULL,           NULL    AS status
    FROM habits    WHERE deleted_at IS NULL AND deleting_at IS NULL AND archived_at IS NULL
  UNION ALL
  SELECT id, 'project'  AS type, name,     NULL,           area_id AS status
    FROM projects  WHERE deleted_at IS NULL AND archived_at IS NULL
  UNION ALL
  SELECT id, 'document' AS type, filename, NULL,           mime    AS status
    FROM documents WHERE deleted_at IS NULL AND deleting_at IS NULL
  UNION ALL
  SELECT id, 'canvas'   AS type, name,     NULL,           NULL    AS status
    FROM canvases  WHERE deleted_at IS NULL AND deleting_at IS NULL;
