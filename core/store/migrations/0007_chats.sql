-- Chats + messages (PLAN §6.8). Conversations with the assistant persist and sync across
-- devices so a chat started on one continues on another, and an in-flight answer is saved
-- when it completes even if no one is looking. Both tables carry the standard sync columns;
-- chats are deleted outright (tombstoned), not trashed.
CREATE TABLE chats (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  config_id  TEXT,               -- pinned provider config; NULL = account default at run time
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  dirty   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_chats_updated ON chats (updated_at DESC);

CREATE TABLE chat_messages (
  id           TEXT PRIMARY KEY,
  chat_id      TEXT NOT NULL,
  seq          INTEGER NOT NULL,   -- ordering within a chat
  role         TEXT NOT NULL,      -- user | assistant | tool
  text         TEXT NOT NULL DEFAULT '',
  tool_calls   TEXT,               -- JSON array of the model's tool calls (assistant turns)
  tool_results TEXT,               -- JSON array of tool results (tool turns)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  dirty   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_chat_messages_chat ON chat_messages (chat_id, seq);
