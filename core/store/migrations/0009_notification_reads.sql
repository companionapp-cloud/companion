-- Notification read receipts (PLAN §6.4). The in-app notification feed is derived live
-- from tasks (notify.FeedTasks); only "the user read this fire" persists, one row per
-- fire, synced so a notification read on one device is read everywhere. The id is
-- deterministic (<task_id>:<fire_at unix-ms>) so devices marking the same fire read
-- independently converge on the same row.
CREATE TABLE notification_reads (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  fire_at    TEXT NOT NULL,
  read_at    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  dirty   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_notification_reads_fire ON notification_reads (fire_at DESC);
