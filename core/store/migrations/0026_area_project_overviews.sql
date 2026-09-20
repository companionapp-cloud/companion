-- Areas and projects become pages (PLAN-areas.md): each gets an optional emoji icon, an
-- optional cover image (a documents row, so its bytes ride the blob pipeline — §6.9) and a
-- rich-text markdown description.
ALTER TABLE areas ADD COLUMN icon TEXT;
ALTER TABLE areas ADD COLUMN cover_document_id TEXT;
ALTER TABLE areas ADD COLUMN description_md TEXT NOT NULL DEFAULT '';

ALTER TABLE projects ADD COLUMN icon TEXT;
ALTER TABLE projects ADD COLUMN cover_document_id TEXT;
ALTER TABLE projects ADD COLUMN description_md TEXT NOT NULL DEFAULT '';

-- Areas hold notes, tasks and canvases directly (PLAN-areas.md §2). A membership row now
-- names its container's kind; for an 'area' row, project_id carries the area's id (the
-- column keeps its name for wire/back-compat with older clients, which see such a row as a
-- membership of an unknown project and ignore it).
ALTER TABLE project_members ADD COLUMN container_type TEXT NOT NULL DEFAULT 'project';
