-- Note ink (PLAN-drawing.md): freehand drawing over a note's text. A note's ink is a set of
-- ink groups (strokes drawn close together), one synced row each, so two devices drawing on
-- the same note merge per group instead of forking the note. The group's strokes and the
-- text anchor that pins it to the note live in data_json, which is encrypted on the wire.
CREATE TABLE note_ink (
  id         TEXT PRIMARY KEY,               -- chosen by the editor (a UUID)
  note_id    TEXT NOT NULL,                  -- plaintext parent, like canvas_nodes.canvas_id
  data_json  TEXT NOT NULL DEFAULT '{}',     -- {v, anchor, strokes}; ENCRYPTED on the wire
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version    INTEGER NOT NULL DEFAULT 0,
  dirty      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_note_ink_note ON note_ink (note_id);
