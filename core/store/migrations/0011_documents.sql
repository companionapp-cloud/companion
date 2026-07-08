-- Documents: file embeds in notes (PLAN §6.9). The row is metadata only; the bytes live
-- in a content-addressed BlobStore keyed by sha256 (core/blob) and sync out-of-band via
-- the server's S3-compatible blob endpoints. A document is a first-class graph node that
-- notes embed with ![[doc:<id>]]; the link extractor derives that into an 'embed' edge.

CREATE TABLE documents (
  id            TEXT PRIMARY KEY,
  filename      TEXT NOT NULL,
  mime          TEXT NOT NULL DEFAULT 'application/octet-stream',
  size          INTEGER NOT NULL DEFAULT 0,
  sha256        TEXT NOT NULL,                -- immutable content address; "replace" = new hash
  blob_uploaded INTEGER NOT NULL DEFAULT 0,   -- client-only, like dirty: bytes confirmed at server
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleting_at TEXT,                            -- Trash: due-to-be-purged instant (PLAN §4.3)
  deleted_at  TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  dirty   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_documents_sha256 ON documents (sha256);

-- Recreate graph_nodes so documents project as nodes (mime rides in the status slot as a
-- type hint, the way tasks project status and projects project area_id). Trashed and
-- tombstoned rows drop out, like every other node type.
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
    FROM documents WHERE deleted_at IS NULL AND deleting_at IS NULL;
