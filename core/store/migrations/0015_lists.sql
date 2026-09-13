-- Lists: project-scoped, drag-ordered collections of tasks with optional headings
-- ("sublists") that group the tasks beneath them. Both tables are synced. A list belongs
-- to exactly one project via a plain column (like a project's area); its items share a
-- single flat sort_order so a task's sublist is the nearest heading above it. Lists are
-- organizational scaffolding like projects: no deleting_at, they delete immediately.

CREATE TABLE lists (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  version     INTEGER NOT NULL DEFAULT 0,
  dirty       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_lists_project ON lists (project_id);

CREATE TABLE list_items (
  id          TEXT PRIMARY KEY,
  list_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,           -- 'task' | 'heading'
  task_id     TEXT,                    -- set for kind='task'
  title       TEXT NOT NULL DEFAULT '',-- heading text for kind='heading'
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  version     INTEGER NOT NULL DEFAULT 0,
  dirty       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_list_items_list ON list_items (list_id, sort_order);
CREATE INDEX idx_list_items_task ON list_items (task_id);
