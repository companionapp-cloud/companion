-- Calendar feeds (PLAN §6.7) can be a subscription URL the server fetches, or an uploaded
-- .ics file whose raw text is stored here and parsed in place. Nullable: URL feeds leave it
-- NULL. Added after 0001's calendar_feeds so uploaded calendars work offline-first.
ALTER TABLE calendar_feeds ADD COLUMN ics_text TEXT;
