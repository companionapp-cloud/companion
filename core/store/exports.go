package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"companion/core/domain"
	"companion/core/sync/protocol"
)

// Export destination kinds and schedules (migration 0029).
const (
	ExportKindFolder = "folder"
	ExportKindGit    = "git"

	ExportOnChanges = "changes"
	ExportHourly    = "hourly"
	ExportDaily     = "daily"
	ExportWeekly    = "weekly"
	ExportManual    = "manual"
)

// ExportDestination is one scheduled export: a folder or a Git remote, how often, and how its
// last run went. Every destination syncs — a folder one as a domain.FolderExport, a Git one as a
// domain.GitExport (see Folder, Git and migration 0030) — but only its device, DeviceID, runs it.
// On that device the run state is its own; on the others it is the exporter's last report.
type ExportDestination struct {
	ID     string          `json:"id"`
	Kind   string          `json:"kind"`
	Name   string          `json:"name"`
	Config json.RawMessage `json:"config"`
	// The credential never crosses the bridge: CredentialEnc holds it when end-to-end encryption
	// is unlocked (it then syncs, sealed), CredentialRef names it in the device's secret store
	// otherwise.
	CredentialEnc string `json:"-"`
	CredentialRef string `json:"-"`
	// DeviceID is the one device that runs the export; DeviceName is what the others show.
	DeviceID   string `json:"deviceId,omitempty"`
	DeviceName string `json:"deviceName,omitempty"`
	// ChangedBy is the device that last changed the settings (Save stamps it).
	ChangedBy     string          `json:"-"`
	Schedule      string          `json:"schedule"`
	Enabled       bool            `json:"enabled"`
	LastRunAt     *time.Time      `json:"lastRunAt,omitempty"`
	LastSuccessAt *time.Time      `json:"lastSuccessAt,omitempty"`
	LastError     string          `json:"lastError,omitempty"`
	LastSummary   json.RawMessage `json:"lastSummary,omitempty"`
	PushPending   bool            `json:"pushPending"`
	// ReportedAt is when this device last queued its run status to sync (the exporter only).
	ReportedAt *time.Time `json:"-"`
	CreatedAt  time.Time  `json:"createdAt"`
	UpdatedAt  time.Time  `json:"updatedAt"`
}

// ExportsRepo owns the export destinations and their manifests.
type ExportsRepo struct {
	db    Driver
	clock domain.Clock
}

const exportColumns = `id, kind, name, config_json, credential_enc, credential_ref, device_id, device_name, changed_by, schedule, enabled, last_run_at, last_success_at, last_error, last_summary_json, push_pending, reported_at, created_at, updated_at`

func (r *ExportsRepo) List() ([]*ExportDestination, error) {
	return r.query(`SELECT ` + exportColumns + ` FROM export_destinations WHERE deleted_at IS NULL ORDER BY created_at, id;`)
}

// Get returns the live destination, or nil when there's none with that id.
func (r *ExportsRepo) Get(id string) (*ExportDestination, error) {
	list, err := r.query(`SELECT `+exportColumns+` FROM export_destinations WHERE id = ? AND deleted_at IS NULL;`, id)
	if err != nil || len(list) == 0 {
		return nil, err
	}
	return list[0], nil
}

// Save inserts the destination (assigning its id) or updates its settings, as changed on this
// device, and queues it to sync. Run state — last_run_at and the rest — is only ever written by
// RecordRun.
func (r *ExportsRepo) Save(d *ExportDestination) error {
	now := r.clock.Now().UTC()
	d.ChangedBy = r.thisDevice()
	if len(d.Config) == 0 {
		d.Config = json.RawMessage(`{}`)
	}
	if d.ID == "" {
		d.ID = uuid.NewString()
		d.CreatedAt = now
	}
	d.UpdatedAt = now
	if _, err := r.db.Exec(
		`INSERT INTO export_destinations (id, kind, name, config_json, credential_enc, credential_ref, device_id, device_name, changed_by, schedule, enabled, created_at, updated_at, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
		 ON CONFLICT(id) DO UPDATE SET name = excluded.name, config_json = excluded.config_json,
		   credential_enc = excluded.credential_enc, credential_ref = excluded.credential_ref,
		   device_id = excluded.device_id, device_name = excluded.device_name, changed_by = excluded.changed_by,
		   schedule = excluded.schedule, enabled = excluded.enabled,
		   updated_at = excluded.updated_at, dirty = 1;`,
		d.ID, d.Kind, d.Name, string(d.Config), nullString(d.CredentialEnc), d.CredentialRef, d.DeviceID, d.DeviceName, d.ChangedBy, d.Schedule, boolToInt(d.Enabled),
		d.CreatedAt.Format(timeFormat), now.Format(timeFormat)); err != nil {
		return fmt.Errorf("save export destination: %w", err)
	}
	return nil
}

// ExportRun is how one run went, as RecordRun stores it.
type ExportRun struct {
	RanAt time.Time
	// Success is when it succeeded; nil when it failed, which leaves last_success_at as it was.
	Success     *time.Time
	Error       string
	Summary     json.RawMessage
	PushPending bool
	// Report queues the outcome to sync, for the other devices to show.
	Report bool
}

// RecordRun stores how a run on deviceID went — unless the export moved to another device while
// it ran, whose record this isn't. A report leaves updated_at alone: that dates the settings
// (domain.ExportStatus).
func (r *ExportsRepo) RecordRun(id, deviceID string, run ExportRun) error {
	ran := run.RanAt.UTC().Format(timeFormat)
	if _, err := r.db.Exec(
		`UPDATE export_destinations SET last_run_at = ?, last_success_at = COALESCE(?, last_success_at),
		   last_error = ?, last_summary_json = CASE WHEN ? = '' THEN last_summary_json ELSE ? END, push_pending = ?,
		   reported_at = CASE WHEN ? THEN ? ELSE reported_at END, dirty = CASE WHEN ? THEN 1 ELSE dirty END
		 WHERE id = ? AND device_id IN (?, '');`,
		ran, nullTime(run.Success), run.Error, string(run.Summary), string(run.Summary), boolToInt(run.PushPending),
		boolToInt(run.Report), ran, boolToInt(run.Report), id, deviceID); err != nil {
		return fmt.Errorf("record export run: %w", err)
	}
	return nil
}

// ResetRunState forgets how the destination's runs went and what it holds — manifest, base
// commit, a commit still to push — for a device about to run it afresh: one taking it over.
func (r *ExportsRepo) ResetRunState(id string) error {
	if err := r.ClearManifest(id); err != nil {
		return err
	}
	if _, err := r.db.Exec(
		`UPDATE export_destinations SET last_run_at = NULL, last_success_at = NULL, last_error = '',
		   last_summary_json = '', push_pending = 0, reported_at = NULL WHERE id = ?;`, id); err != nil {
		return fmt.Errorf("reset export run state: %w", err)
	}
	return nil
}

// ClaimFolders gives this device the folder destinations made before they synced (migration
// 0030) — it is the only device that can have made them — and queues them to sync.
func (r *ExportsRepo) ClaimFolders(deviceID, deviceName string) (int64, error) {
	if deviceID == "" {
		return 0, nil
	}
	res, err := r.db.Exec(
		`UPDATE export_destinations SET device_id = ?, device_name = ?, changed_by = ?, updated_at = ?, dirty = 1
		 WHERE kind = ? AND device_id = '' AND deleted_at IS NULL;`,
		deviceID, deviceName, deviceID, r.clock.Now().UTC().Format(timeFormat), ExportKindFolder)
	if err != nil {
		return 0, fmt.Errorf("claim folder exports: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// SetDeviceName refreshes the name the other devices show on this device's exports (a rename).
func (r *ExportsRepo) SetDeviceName(deviceID, deviceName string) error {
	if _, err := r.db.Exec(
		`UPDATE export_destinations SET device_name = ?, changed_by = ?, updated_at = ?, dirty = 1
		 WHERE device_id = ? AND device_name <> ? AND deleted_at IS NULL;`,
		deviceName, deviceID, r.clock.Now().UTC().Format(timeFormat), deviceID, deviceName); err != nil {
		return fmt.Errorf("set export device name: %w", err)
	}
	return nil
}

// Delete forgets the destination on every device: its manifest goes, and the row becomes a
// tombstone — credential wiped — so the deletion reaches the others. What it exported stays
// where it is.
func (r *ExportsRepo) Delete(id string) error {
	if _, err := r.db.Exec(`DELETE FROM export_manifest WHERE destination_id = ?;`, id); err != nil {
		return fmt.Errorf("delete export manifest: %w", err)
	}
	now := r.clock.Now().UTC().Format(timeFormat)
	if _, err := r.db.Exec(
		`UPDATE export_destinations SET deleted_at = ?, updated_at = ?, changed_by = ?, credential_enc = NULL, credential_ref = '', dirty = 1
		 WHERE id = ? AND deleted_at IS NULL;`, now, now, r.thisDevice(), id); err != nil {
		return fmt.Errorf("delete export destination: %w", err)
	}
	return nil
}

func nullString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// ExportManifestRow is one file a destination holds: whose it is, and its content hash. (The
// store can't import core/export — export reads the store — so the bridge maps between them.)
type ExportManifestRow struct {
	Path       string
	EntityType string
	EntityID   string
	SHA        string
}

// Manifest is what the destination holds.
func (r *ExportsRepo) Manifest(id string) ([]ExportManifestRow, error) {
	rows, err := r.db.Query(`SELECT path, entity_type, entity_id, content_sha FROM export_manifest WHERE destination_id = ? ORDER BY path;`, id)
	if err != nil {
		return nil, fmt.Errorf("query export manifest: %w", err)
	}
	defer rows.Close()
	var out []ExportManifestRow
	for rows.Next() {
		var m ExportManifestRow
		if err := rows.Scan(&m.Path, &m.EntityType, &m.EntityID, &m.SHA); err != nil {
			return nil, fmt.Errorf("scan export manifest: %w", err)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// ApplyToManifest records what reached the destination: files written, and paths removed.
func (r *ExportsRepo) ApplyToManifest(id string, written []ExportManifestRow, removed []string) error {
	for _, path := range removed {
		if _, err := r.db.Exec(`DELETE FROM export_manifest WHERE destination_id = ? AND path = ?;`, id, path); err != nil {
			return fmt.Errorf("update export manifest: %w", err)
		}
	}
	for _, m := range written {
		if _, err := r.db.Exec(
			`INSERT INTO export_manifest (destination_id, path, entity_type, entity_id, content_sha) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(destination_id, path) DO UPDATE SET entity_type = excluded.entity_type, entity_id = excluded.entity_id, content_sha = excluded.content_sha;`,
			id, m.Path, m.EntityType, m.EntityID, m.SHA); err != nil {
			return fmt.Errorf("update export manifest: %w", err)
		}
	}
	return nil
}

// ClearManifest forgets what the destination holds — and the commit that was true of — so the
// next run starts from scratch.
func (r *ExportsRepo) ClearManifest(id string) error {
	if _, err := r.db.Exec(`DELETE FROM export_manifest WHERE destination_id = ?;`, id); err != nil {
		return err
	}
	_, err := r.db.Exec(`UPDATE export_destinations SET base_commit = '' WHERE id = ?;`, id)
	return err
}

// BaseCommit is the commit a Git destination last synced with on this device; "" before the
// first sync.
func (r *ExportsRepo) BaseCommit(id string) (string, error) {
	rows, err := r.db.Query(`SELECT base_commit FROM export_destinations WHERE id = ?;`, id)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	var base string
	if rows.Next() {
		if err := rows.Scan(&base); err != nil {
			return "", err
		}
	}
	return base, rows.Err()
}

func (r *ExportsRepo) SetBaseCommit(id, commit string) error {
	_, err := r.db.Exec(`UPDATE export_destinations SET base_commit = ? WHERE id = ?;`, commit, id)
	return err
}

func (r *ExportsRepo) query(q string, args ...any) ([]*ExportDestination, error) {
	rows, err := r.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("query export destinations: %w", err)
	}
	defer rows.Close()
	var out []*ExportDestination
	for rows.Next() {
		var (
			d                                ExportDestination
			config, summary                  string
			enabled, pushPending             int
			lastRun, lastSuccess, reportedAt sql.NullString
			credentialEnc                    sql.NullString
			createdAt, updatedAt             string
		)
		if err := rows.Scan(&d.ID, &d.Kind, &d.Name, &config, &credentialEnc, &d.CredentialRef, &d.DeviceID, &d.DeviceName, &d.ChangedBy, &d.Schedule, &enabled, &lastRun, &lastSuccess, &d.LastError, &summary, &pushPending, &reportedAt, &createdAt, &updatedAt); err != nil {
			return nil, fmt.Errorf("scan export destination: %w", err)
		}
		d.CredentialEnc = credentialEnc.String
		d.Config = json.RawMessage(config)
		if summary != "" {
			d.LastSummary = json.RawMessage(summary)
		}
		d.Enabled, d.PushPending = enabled != 0, pushPending != 0
		d.LastRunAt, d.LastSuccessAt, d.ReportedAt = optionalTime(lastRun), optionalTime(lastSuccess), optionalTime(reportedAt)
		d.CreatedAt, _ = time.Parse(timeFormat, createdAt)
		d.UpdatedAt, _ = time.Parse(timeFormat, updatedAt)
		out = append(out, &d)
	}
	return out, rows.Err()
}

// optionalTime reads a nullable time column, taking an unreadable one as unset.
func optionalTime(s sql.NullString) *time.Time {
	if !s.Valid {
		return nil
	}
	t, err := time.Parse(timeFormat, s.String)
	if err != nil {
		return nil
	}
	return &t
}

// ---- sync ---------------------------------------------------------------------------------

// Git and Folder are the repo's faces to the sync engine: the Git destinations as
// domain.GitExport rows, the folder ones as domain.FolderExport rows. Both kinds share
// export_destinations, and each face sees only its own.
func (r *ExportsRepo) Git() *GitExportsSync       { return &GitExportsSync{r} }
func (r *ExportsRepo) Folder() *FolderExportsSync { return &FolderExportsSync{r} }

// syncedExport is the part of a destination that travels, whichever its kind.
type syncedExport struct {
	ID, Name             string
	Config               json.RawMessage
	CredentialEnc        *string // Git only
	Schedule             string
	Enabled              bool
	DeviceID, DeviceName string
	ChangedBy            string
	Status               domain.ExportStatus
	CreatedAt, UpdatedAt time.Time
	DeletedAt            *time.Time
	Version              int64
	Dirty                bool
}

const syncedExportColumns = `id, name, config_json, credential_enc, schedule, enabled, device_id, device_name, changed_by, last_run_at, last_success_at, last_error, created_at, updated_at, deleted_at, version, dirty`

func (r *ExportsRepo) syncedDirty(kind string) ([]syncedExport, error) {
	return r.querySynced(`SELECT `+syncedExportColumns+` FROM export_destinations WHERE dirty = 1 AND kind = ? ORDER BY updated_at, id;`, kind)
}

func (r *ExportsRepo) syncedGet(kind, id string) (syncedExport, error) {
	out, err := r.querySynced(`SELECT `+syncedExportColumns+` FROM export_destinations WHERE id = ? AND kind = ?;`, id, kind)
	if err != nil {
		return syncedExport{}, err
	}
	if len(out) == 0 {
		return syncedExport{}, ErrNotFound
	}
	return out[0], nil
}

// thisDevice is this install's device id ("" before it has one).
func (r *ExportsRepo) thisDevice() string {
	rows, err := r.db.Query(`SELECT device_id FROM sync_state WHERE id = 1;`)
	if err != nil {
		return ""
	}
	defer rows.Close()
	var id sql.NullString
	if rows.Next() {
		_ = rows.Scan(&id)
	}
	return id.String
}

// laterTime reports whether a is set and after b (an unset b is earlier than anything).
func laterTime(a, b *time.Time) bool {
	return a != nil && (b == nil || a.After(*b))
}

// applySynced overwrites the travelling half of a row with the server's copy and clears dirty.
// What this device keeps for itself — what it has exported (the manifest, the base commit), a
// credential in its secret store — is left alone, except that a tombstone takes the manifest
// with it, and a row now run by another device drops this one's unpushed commit.
//
// The run status is merged rather than overwritten. Only the exporting device reports it, but
// any device changing a setting sends the row back with whatever report it last saw, so an
// incoming report replaces ours only when it is newer, or comes from a different exporter. And
// when the exporter finds its own newer report overwritten that way, the row stays dirty so the
// report goes out again.
func (r *ExportsRepo) applySynced(kind string, e syncedExport) error {
	config := string(e.Config)
	if config == "" {
		config = "{}"
	}
	var credential any
	if e.CredentialEnc != nil && *e.CredentialEnc != "" {
		credential = *e.CredentialEnc
	}
	me := r.thisDevice()
	status, dirty := e.Status, false
	local, err := r.syncedGet(kind, e.ID)
	switch {
	case errors.Is(err, ErrNotFound):
	case err != nil:
		return err
	case local.DeviceID == e.DeviceID && !laterTime(e.Status.LastRunAt, local.Status.LastRunAt):
		status = local.Status
		dirty = e.DeviceID == me && me != "" && laterTime(local.Status.LastRunAt, e.Status.LastRunAt) && e.DeletedAt == nil
	}
	if _, err := r.db.Exec(
		`INSERT INTO export_destinations (id, kind, name, config_json, credential_enc, schedule, enabled, device_id, device_name, changed_by,
		   last_run_at, last_success_at, last_error, created_at, updated_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET name = excluded.name, config_json = excluded.config_json,
		   credential_enc = excluded.credential_enc, schedule = excluded.schedule, enabled = excluded.enabled,
		   device_id = excluded.device_id, device_name = excluded.device_name, changed_by = excluded.changed_by,
		   last_run_at = excluded.last_run_at, last_success_at = excluded.last_success_at, last_error = excluded.last_error,
		   push_pending = CASE WHEN ? THEN export_destinations.push_pending ELSE 0 END,
		   created_at = excluded.created_at, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
		   version = excluded.version, dirty = excluded.dirty;`,
		e.ID, kind, e.Name, config, credential, e.Schedule, boolToInt(e.Enabled), e.DeviceID, e.DeviceName, e.ChangedBy,
		nullTime(status.LastRunAt), nullTime(status.LastSuccessAt), status.LastError,
		e.CreatedAt.UTC().Format(timeFormat), e.UpdatedAt.UTC().Format(timeFormat), nullTime(e.DeletedAt), e.Version, boolToInt(dirty),
		boolToInt(e.DeviceID == me && me != "")); err != nil {
		return fmt.Errorf("apply %s export: %w", kind, err)
	}
	if e.DeletedAt != nil {
		if err := r.ClearManifest(e.ID); err != nil {
			return fmt.Errorf("apply %s export: %w", kind, err)
		}
	}
	return nil
}

func (r *ExportsRepo) markPushed(id string, version int64) error {
	if _, err := r.db.Exec(`UPDATE export_destinations SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark export pushed: %w", err)
	}
	return nil
}

func (r *ExportsRepo) querySynced(q string, args ...any) ([]syncedExport, error) {
	rows, err := r.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("query synced exports: %w", err)
	}
	defer rows.Close()
	out := []syncedExport{}
	for rows.Next() {
		var (
			e                                           syncedExport
			config                                      string
			credential, lastRun, lastSuccess, deletedAt sql.NullString
			enabled, dirty                              int
			createdAt, updatedAt                        string
		)
		if err := rows.Scan(&e.ID, &e.Name, &config, &credential, &e.Schedule, &enabled, &e.DeviceID, &e.DeviceName, &e.ChangedBy,
			&lastRun, &lastSuccess, &e.Status.LastError, &createdAt, &updatedAt, &deletedAt, &e.Version, &dirty); err != nil {
			return nil, fmt.Errorf("scan synced export: %w", err)
		}
		e.Config = json.RawMessage(config)
		if credential.Valid && credential.String != "" {
			e.CredentialEnc = &credential.String
		}
		e.Enabled, e.Dirty = enabled != 0, dirty != 0
		e.Status.LastRunAt, e.Status.LastSuccessAt, e.DeletedAt = optionalTime(lastRun), optionalTime(lastSuccess), optionalTime(deletedAt)
		e.CreatedAt, _ = time.Parse(timeFormat, createdAt)
		e.UpdatedAt, _ = time.Parse(timeFormat, updatedAt)
		out = append(out, e)
	}
	return out, rows.Err()
}

// GitExportsSync implements sync.SyncableRepo[*domain.GitExport].
type GitExportsSync struct{ r *ExportsRepo }

func (g *GitExportsSync) EntityType() string { return protocol.EntityGitExport }

func (g *GitExportsSync) Dirty() ([]*domain.GitExport, error) {
	rows, err := g.r.syncedDirty(ExportKindGit)
	if err != nil {
		return nil, err
	}
	out := make([]*domain.GitExport, len(rows))
	for i, e := range rows {
		out[i] = e.git()
	}
	return out, nil
}

func (g *GitExportsSync) GetAny(id string) (*domain.GitExport, error) {
	e, err := g.r.syncedGet(ExportKindGit, id)
	if err != nil {
		return nil, err
	}
	return e.git(), nil
}

// Apply takes the server's copy of a Git export (applySynced). A credential arriving in the row
// supersedes this device's secret-store ref; a row without one leaves the ref alone.
func (g *GitExportsSync) Apply(e *domain.GitExport) error {
	if err := e.Validate(); err != nil {
		return err
	}
	return g.r.applySynced(ExportKindGit, syncedExport{
		ID: e.ID, Name: e.Name, Config: e.Config, CredentialEnc: e.CredentialEnc, Schedule: e.Schedule, Enabled: e.Enabled,
		DeviceID: e.DeviceID, DeviceName: e.DeviceName, ChangedBy: e.ChangedBy, Status: e.ExportStatus,
		CreatedAt: e.CreatedAt, UpdatedAt: e.UpdatedAt, DeletedAt: e.DeletedAt, Version: e.Version,
	})
}

func (g *GitExportsSync) MarkPushed(id string, version int64) error {
	return g.r.markPushed(id, version)
}

// Settings, not prose: on a conflict the server's copy simply wins, as with calendar accounts.
func (g *GitExportsSync) MeaningfulDiff(a, b *domain.GitExport) bool { return false }

func (g *GitExportsSync) ConflictedCopy(*domain.GitExport, string) error { return nil }

func (g *GitExportsSync) Decode(raw json.RawMessage) (*domain.GitExport, error) {
	var e domain.GitExport
	if err := json.Unmarshal(raw, &e); err != nil {
		return nil, fmt.Errorf("decode git export: %w", err)
	}
	return &e, nil
}

func (e syncedExport) git() *domain.GitExport {
	return &domain.GitExport{
		ID: e.ID, Name: e.Name, Config: e.Config, CredentialEnc: e.CredentialEnc, Schedule: e.Schedule, Enabled: e.Enabled,
		DeviceID: e.DeviceID, DeviceName: e.DeviceName, ChangedBy: e.ChangedBy, ExportStatus: e.Status,
		CreatedAt: e.CreatedAt, UpdatedAt: e.UpdatedAt, DeletedAt: e.DeletedAt, Version: e.Version, Dirty: e.Dirty,
	}
}

// FolderExportsSync implements sync.SyncableRepo[*domain.FolderExport].
type FolderExportsSync struct{ r *ExportsRepo }

func (f *FolderExportsSync) EntityType() string { return protocol.EntityFolderExport }

func (f *FolderExportsSync) Dirty() ([]*domain.FolderExport, error) {
	rows, err := f.r.syncedDirty(ExportKindFolder)
	if err != nil {
		return nil, err
	}
	out := make([]*domain.FolderExport, len(rows))
	for i, e := range rows {
		out[i] = e.folder()
	}
	return out, nil
}

func (f *FolderExportsSync) GetAny(id string) (*domain.FolderExport, error) {
	e, err := f.r.syncedGet(ExportKindFolder, id)
	if err != nil {
		return nil, err
	}
	return e.folder(), nil
}

func (f *FolderExportsSync) Apply(e *domain.FolderExport) error {
	if err := e.Validate(); err != nil {
		return err
	}
	return f.r.applySynced(ExportKindFolder, syncedExport{
		ID: e.ID, Name: e.Name, Config: e.Config, Schedule: e.Schedule, Enabled: e.Enabled,
		DeviceID: e.DeviceID, DeviceName: e.DeviceName, ChangedBy: e.ChangedBy, Status: e.ExportStatus,
		CreatedAt: e.CreatedAt, UpdatedAt: e.UpdatedAt, DeletedAt: e.DeletedAt, Version: e.Version,
	})
}

func (f *FolderExportsSync) MarkPushed(id string, version int64) error {
	return f.r.markPushed(id, version)
}

// Settings, like a Git export's: on a conflict the server's copy wins.
func (f *FolderExportsSync) MeaningfulDiff(a, b *domain.FolderExport) bool { return false }

func (f *FolderExportsSync) ConflictedCopy(*domain.FolderExport, string) error { return nil }

func (f *FolderExportsSync) Decode(raw json.RawMessage) (*domain.FolderExport, error) {
	var e domain.FolderExport
	if err := json.Unmarshal(raw, &e); err != nil {
		return nil, fmt.Errorf("decode folder export: %w", err)
	}
	return &e, nil
}

func (e syncedExport) folder() *domain.FolderExport {
	return &domain.FolderExport{
		ID: e.ID, Name: e.Name, Config: e.Config, Schedule: e.Schedule, Enabled: e.Enabled,
		DeviceID: e.DeviceID, DeviceName: e.DeviceName, ChangedBy: e.ChangedBy, ExportStatus: e.Status,
		CreatedAt: e.CreatedAt, UpdatedAt: e.UpdatedAt, DeletedAt: e.DeletedAt, Version: e.Version, Dirty: e.Dirty,
	}
}
