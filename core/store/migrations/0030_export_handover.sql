-- Exports seen from every device (core/bridge/export.go). A folder destination now syncs too
-- (entity "folder_export"), so the other devices know a folder is being written, by which
-- device, and can pause it or take it over; only the device named in device_id ever writes it.
-- Folder rows made before this have no device yet: the core claims them for this device at
-- startup (ExportsRepo.ClaimFolders), which is the only one that can have made them.
--
-- The exporting device also reports how its runs go (last_run_at, last_success_at, last_error
-- now travel with the row). reported_at is when it last queued such a report, so a quiet export
-- reports hourly rather than after every run. A report never moves updated_at: that dates the
-- settings, so a pause or takeover from another device wins any race with a report.
--
-- changed_by is the device that last changed the settings (it travels too). A change made on a
-- device other than the exporter is pending until the exporter has synced since.

ALTER TABLE export_destinations ADD COLUMN reported_at TEXT;
ALTER TABLE export_destinations ADD COLUMN changed_by TEXT NOT NULL DEFAULT '';
