-- Tasks get a start and any number of reminders (PLAN §6.4). due_at keeps its name but is
-- presented as the task's deadline; relative reminders count back from it.
ALTER TABLE tasks ADD COLUMN start_at TEXT;

-- A JSON array of {"at": RFC3339} (absolute) and {"before": ISO-8601 lead} (relative to the
-- deadline) reminders, normalized by core (domain.NormalizeReminders).
ALTER TABLE tasks ADD COLUMN reminders_json TEXT NOT NULL DEFAULT '[]';

-- The single reminder a task could carry before becomes the first entry of its list. The
-- server moves its copy the same way, so the migrated rows agree without a re-sync.
UPDATE tasks SET reminders_json = '[{"at":"' || remind_at || '"}]' WHERE remind_at IS NOT NULL;

ALTER TABLE tasks DROP COLUMN remind_at;
