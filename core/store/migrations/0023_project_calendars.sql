-- Calendars in projects (PLAN §6.6). A project holds a calendar, or a whole calendar account, through
-- an ordinary project_members row (entity_type 'calendar' or 'calendar_account'), so the table needs
-- no change. Calendars are not graph nodes, so those rows are not mirrored as `member` edges — but a
-- client from before this migration mirrored every membership it pulled, which left ghost nodes in
-- its graph. Drop them.
DELETE FROM links WHERE kind = 'member' AND target_type IN ('calendar', 'calendar_account');
