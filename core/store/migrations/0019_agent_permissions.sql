-- Two independent permission switches per agent (PLAN-agents.md §0, "CLI permissions"):
--   allow_write  — Companion's own write tools (create/update notes and tasks). ON by default:
--                  acting on the workspace is the point of the assistant.
--   allow_system — file edits and shell commands on the hosting computer (CLI agents only).
--                  OFF by default: a phone driving a CLI with system access is a real footgun.
-- allow_write previously meant "system access"; existing rows are moved to the new column and
-- get write tools on, matching the new defaults.
ALTER TABLE llm_configs ADD COLUMN allow_system INTEGER NOT NULL DEFAULT 0;
UPDATE llm_configs SET allow_system = allow_write;
UPDATE llm_configs SET allow_write = 1;
