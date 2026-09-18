-- CalDAV accounts and two-way calendars (PLAN-caldav.md §1.1).
--
-- An account is a login on a CalDAV server. Each calendar it exposes becomes a calendar_feeds row
-- of kind 'caldav' whose url is the collection URL. Every event resource in that collection is
-- kept verbatim in calendar_objects, and calendar_events stays what it always was: occurrences
-- derived from ICS, here from the object's ICS rather than from a feed body.

CREATE TABLE calendar_accounts (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  server_url     TEXT NOT NULL,              -- what the user entered
  username       TEXT NOT NULL DEFAULT '',
  auth_kind      TEXT NOT NULL DEFAULT 'basic',
  credential_enc TEXT,                       -- password; rides in the synced row on E2EE accounts
  credential_ref TEXT,                       -- device secret-store handle otherwise (never synced in the clear)
  home_set_url   TEXT NOT NULL DEFAULT '',   -- discovered calendar-home-set, so a rescan skips discovery
  last_error     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,
  version        INTEGER NOT NULL DEFAULT 0,
  dirty          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_calendar_accounts_dirty ON calendar_accounts (dirty);

ALTER TABLE calendar_feeds ADD COLUMN kind       TEXT NOT NULL DEFAULT 'ics';
ALTER TABLE calendar_feeds ADD COLUMN account_id TEXT;
ALTER TABLE calendar_feeds ADD COLUMN read_only  INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_calendar_feeds_account ON calendar_feeds (account_id);

-- One row per calendar object resource (all VEVENTs sharing a UID). id is UUIDv5(feed|uid) so
-- every device that pulls the same calendar converges on the same row.
CREATE TABLE calendar_objects (
  id         TEXT PRIMARY KEY,
  feed_id    TEXT NOT NULL,
  uid        TEXT NOT NULL,
  href       TEXT NOT NULL DEFAULT '',        -- resource URL on the provider; '' until first push
  etag       TEXT NOT NULL DEFAULT '',
  ics        TEXT NOT NULL,
  recurring  INTEGER NOT NULL DEFAULT 0,      -- derived from ics; plaintext so Range can join on it
  push_state TEXT NOT NULL DEFAULT 'synced',  -- synced | pending_create | pending_update | pending_delete
  push_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version    INTEGER NOT NULL DEFAULT 0,
  dirty      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_calendar_objects_feed ON calendar_objects (feed_id);
CREATE INDEX idx_calendar_objects_feed_uid ON calendar_objects (feed_id, uid);
CREATE INDEX idx_calendar_objects_dirty ON calendar_objects (dirty);
CREATE INDEX idx_calendar_objects_push ON calendar_objects (push_state);

-- Device-local pull bookkeeping. Deliberately not synced: a ctag says what THIS device has pulled.
CREATE TABLE caldav_feed_state (
  feed_id TEXT PRIMARY KEY,
  ctag    TEXT NOT NULL DEFAULT ''
);
