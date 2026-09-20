-- Scheduling for projects, and Someday for tasks and projects (PLAN-scheduling.md).

-- "Someday" stands in for a start date: the item is filed away until the user picks it back
-- up. It excludes a start_at (core clears one when it sets the other); a deadline may remain.
ALTER TABLE tasks ADD COLUMN someday INTEGER NOT NULL DEFAULT 0;

-- A project gets a task's scheduling shape: a start, a deadline (due_at, presented as
-- "Deadline" exactly like tasks.due_at), Someday, and a completion instant. A completed
-- project is hidden everywhere but the Logbook.
ALTER TABLE projects ADD COLUMN start_at TEXT;
ALTER TABLE projects ADD COLUMN due_at TEXT;
ALTER TABLE projects ADD COLUMN someday INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN completed_at TEXT;

-- A project repeats either on a schedule (repeat_rule, an RFC5545 RRULE like a task's) or a
-- fixed interval after it is completed (repeat_after, e.g. "P3D", "P2W", "P1M", "P1Y") — never
-- both. The server spawns the next copy and moves the rule onto it (PLAN-scheduling.md §3).
ALTER TABLE projects ADD COLUMN repeat_rule TEXT;
ALTER TABLE projects ADD COLUMN repeat_after TEXT;
