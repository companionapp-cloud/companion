-- Object types / archetypes (PLAN §4.0, §4.1, §6.3). An object type turns a note or task
-- into a structured object: the entity carries object_type_id + props_json and the type's
-- schema_json defines the fields, validation, and display. Definitions sync like any other
-- entity. reference-typed fields produce prop:<field> edges in the local links index.

CREATE TABLE object_types (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  applies_to     TEXT NOT NULL,          -- 'note' | 'task' | 'both'
  schema_version INTEGER NOT NULL DEFAULT 1,
  schema_json    TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  dirty   INTEGER NOT NULL DEFAULT 1
);

-- Archetype columns on notes and tasks (PLAN §4.1). NULL object_type_id = a plain note/
-- task; props_json holds the schema-validated metadata (default empty object).
ALTER TABLE notes ADD COLUMN object_type_id TEXT;
ALTER TABLE notes ADD COLUMN props_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE tasks ADD COLUMN object_type_id TEXT;
ALTER TABLE tasks ADD COLUMN props_json TEXT NOT NULL DEFAULT '{}';

-- Recreate graph_nodes so notes/tasks project their real object_type_id (until now the
-- view hard-coded NULL). This lets the graph cluster nodes by archetype (PLAN §5.3).
DROP VIEW graph_nodes;
CREATE VIEW graph_nodes AS
  SELECT id, 'note'    AS type, title, object_type_id, NULL    AS status
    FROM notes    WHERE deleted_at IS NULL AND deleting_at IS NULL
  UNION ALL
  SELECT id, 'task'    AS type, title, object_type_id, status  AS status
    FROM tasks    WHERE deleted_at IS NULL AND deleting_at IS NULL
  UNION ALL
  SELECT id, 'habit'   AS type, name,  NULL,           NULL    AS status
    FROM habits   WHERE deleted_at IS NULL AND deleting_at IS NULL AND archived_at IS NULL
  UNION ALL
  SELECT id, 'project' AS type, name,  NULL,           area_id AS status
    FROM projects WHERE deleted_at IS NULL AND archived_at IS NULL;
