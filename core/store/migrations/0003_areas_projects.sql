-- Areas, projects, and project membership (PLAN §4.0, §4.1, §6.6). Areas group
-- projects (a flat, ordered sidebar heading list); a project belongs to exactly one
-- area via a plain column. project_members is an AUTHORED edge (synced), mirrored into
-- the local `links` index as kind 'member' by the store.

CREATE TABLE areas (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  dirty   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  area_id     TEXT NOT NULL,      -- exactly ONE area (column, not an edge table)
  name        TEXT NOT NULL,
  color       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  dirty   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_projects_area ON projects (area_id);

CREATE TABLE project_members (    -- AUTHORED edges: project ⇄ note/task/habit (synced)
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  entity_type TEXT NOT NULL,      -- 'note' | 'task' | 'habit'
  entity_id   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  dirty   INTEGER NOT NULL DEFAULT 1,
  UNIQUE (project_id, entity_type, entity_id)
);
CREATE INDEX idx_project_members_entity ON project_members (entity_type, entity_id);

-- Recreate graph_nodes to add project nodes so `member` edges resolve to a real node
-- and the graph can cluster by a project's area (carried in the status column, per
-- PLAN §5 line "SELECT id, 'project', name, NULL, area_id").
DROP VIEW graph_nodes;
CREATE VIEW graph_nodes AS
  SELECT id, 'note'    AS type, title, NULL AS object_type_id, NULL    AS status
    FROM notes    WHERE deleted_at IS NULL
  UNION ALL
  SELECT id, 'task'    AS type, title, NULL AS object_type_id, status  AS status
    FROM tasks    WHERE deleted_at IS NULL
  UNION ALL
  SELECT id, 'habit'   AS type, name,  NULL AS object_type_id, NULL    AS status
    FROM habits   WHERE deleted_at IS NULL AND archived_at IS NULL
  UNION ALL
  SELECT id, 'project' AS type, name,  NULL AS object_type_id, area_id AS status
    FROM projects WHERE deleted_at IS NULL AND archived_at IS NULL;
