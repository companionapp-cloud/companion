-- Onboarding tours (the guided walk through each tool). A row records that the user finished
-- or skipped one version of one tour; a tour is settled once a live row exists for its current
-- version or a later one. Rows are facts, never edited: two devices settling the same tour
-- before they sync leave two rows that mean the same thing, so ids are random rather than
-- derived (the server keys rows by id alone, so a derived id would collide across accounts).
-- Replaying tours from scratch tombstones the rows. Synced so a tour seen on one device is
-- seen on all of them. The same table holds the welcome sheet (tour 'welcome') and whether the
-- user wants tours at all (tour 'tutorials': its one live row's outcome is the answer).
CREATE TABLE onboarding (
  id           TEXT PRIMARY KEY,
  tour         TEXT NOT NULL,
  tour_version INTEGER NOT NULL,
  outcome      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  dirty   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_onboarding_tour ON onboarding (tour, tour_version);
