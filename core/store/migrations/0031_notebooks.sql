-- Notebooks (PLAN-notebooks.md): paper notebooks of fixed A5 pages, each page typed text and
-- ink on the same sheet. Pages are their own entity, never notes: they do not appear under
-- Notes and only open on their sheet. Three synced tables so two devices editing different
-- pages, or different ink groups on one page, merge per row. A notebook is trashable like a
-- note; its pages and ink follow it and tombstone directly, as canvas nodes follow a board.
-- (0028 remains skipped on purpose; see 0029_exports.sql.)

CREATE TABLE notebooks (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL DEFAULT '',     -- ENCRYPTED on the wire
  cover_color       TEXT NOT NULL DEFAULT 'ink',  -- a named cover colour (the app owns the list)
  cover_document_id TEXT,                         -- an uploaded cover image (documents.id)
  settings_json     TEXT NOT NULL DEFAULT '{}',   -- {guides: [...]}; ENCRYPTED on the wire
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleting_at       TEXT,                         -- Trash (PLAN §4.3)
  deleted_at        TEXT,
  version           INTEGER NOT NULL DEFAULT 0,
  dirty             INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE notebook_pages (
  id            TEXT PRIMARY KEY,
  notebook_id   TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,       -- dense, rewritten on insert/reorder (like list_items)
  paper_kind    TEXT NOT NULL DEFAULT 'lined',    -- blank | lined | grid | dots
  paper_spacing INTEGER NOT NULL DEFAULT 28,      -- rule pitch in page px: 24 | 28 | 32
  content_md    TEXT NOT NULL DEFAULT '',         -- ENCRYPTED on the wire
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  version       INTEGER NOT NULL DEFAULT 0,
  dirty         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_notebook_pages_notebook ON notebook_pages (notebook_id, sort_order);

-- Ink on a page: the note_ink shape keyed to a page. The payload is the same format (the
-- anchor is {page: true}: strokes in page coordinates). notebook_id is carried too so a purged
-- notebook takes its ink with it in one pass, on the client and on the server.
CREATE TABLE notebook_page_ink (
  id          TEXT PRIMARY KEY,                   -- chosen by the editor (a UUID)
  notebook_id TEXT NOT NULL,
  page_id     TEXT NOT NULL,
  data_json   TEXT NOT NULL DEFAULT '{}',         -- {v, anchor, strokes}; ENCRYPTED on the wire
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  version     INTEGER NOT NULL DEFAULT 0,
  dirty       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_notebook_page_ink_page ON notebook_page_ink (page_id);
CREATE INDEX idx_notebook_page_ink_notebook ON notebook_page_ink (notebook_id);
