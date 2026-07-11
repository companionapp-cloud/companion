-- Calendar (PLAN §6.7). The calendar_feeds/calendar_events tables were created in 0001;
-- these indexes back the merged calendar.range query (events overlapping a window, joined
-- to their feed) so the week grid and day agenda stay cheap as the event clone grows.
CREATE INDEX IF NOT EXISTS idx_calendar_events_starts_at ON calendar_events (starts_at);
CREATE INDEX IF NOT EXISTS idx_calendar_events_feed_id ON calendar_events (feed_id);
