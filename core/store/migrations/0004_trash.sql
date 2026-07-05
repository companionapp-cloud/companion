-- Trash / 30-day retention (PLAN §4.3). Trashable entities gain a `deleting_at` marker:
-- the instant the row is due to be permanently deleted (set to now + 30d on delete). A
-- non-NULL deleting_at hides the row from every query but the Trash query and drops it
-- from the graph, while it keeps syncing until the server's collector purges it (§7.6).
-- Projects and areas are never trashed, so they get no such column.

ALTER TABLE notes  ADD COLUMN deleting_at TEXT;
ALTER TABLE tasks  ADD COLUMN deleting_at TEXT;
ALTER TABLE habits ADD COLUMN deleting_at TEXT;

-- Recreate graph_nodes so trashed notes/tasks/habits fall out of the graph exactly like
-- tombstones do. Projects/areas are unchanged (they don't trash).
DROP VIEW graph_nodes;
CREATE VIEW graph_nodes AS
  SELECT id, 'note'    AS type, title, NULL AS object_type_id, NULL    AS status
    FROM notes    WHERE deleted_at IS NULL AND deleting_at IS NULL
  UNION ALL
  SELECT id, 'task'    AS type, title, NULL AS object_type_id, status  AS status
    FROM tasks    WHERE deleted_at IS NULL AND deleting_at IS NULL
  UNION ALL
  SELECT id, 'habit'   AS type, name,  NULL AS object_type_id, NULL    AS status
    FROM habits   WHERE deleted_at IS NULL AND deleting_at IS NULL AND archived_at IS NULL
  UNION ALL
  SELECT id, 'project' AS type, name,  NULL AS object_type_id, area_id AS status
    FROM projects WHERE deleted_at IS NULL AND archived_at IS NULL;
