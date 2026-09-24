-- Pomodoros: timed focus sessions on a task. A row is created running (outcome '') and
-- settled once: 'completed' when the task was finished inside the window (the only outcome
-- that counts, and it earns a break until break_ends_at), 'expired' when the window ran out
-- first, 'cancelled' when the user gave up. Synced so the count follows the user.
CREATE TABLE pomodoros (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  duration_sec  INTEGER NOT NULL,
  outcome       TEXT NOT NULL DEFAULT '',
  ended_at      TEXT,
  break_ends_at TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  dirty   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_pomodoros_outcome_ended ON pomodoros (outcome, ended_at);
CREATE INDEX idx_pomodoros_task ON pomodoros (task_id);
