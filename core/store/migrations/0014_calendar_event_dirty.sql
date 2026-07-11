-- End-to-end encryption (PLAN §E2EE) moves ICS fetching from the server to the client, so
-- calendar events are now pushed by the client (encrypted) like any entity rather than being
-- server-owned pull-only rows. That makes them dirty-trackable.
ALTER TABLE calendar_events ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_calendar_events_dirty ON calendar_events (dirty);
