package store

import (
	"database/sql"
	"encoding/json"
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
// last run went on this device. A folder destination is local; a Git one syncs as a
// domain.GitExport (see Git and the migration) — its settings and credential travel, its run
// state doesn't.
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
	// DeviceID is the one device that runs a Git export; DeviceName is what the others show.
	DeviceID      string          `json:"deviceId,omitempty"`
	DeviceName    string          `json:"deviceName,omitempty"`
	Schedule      string          `json:"schedule"`
	Enabled       bool            `json:"enabled"`
	LastRunAt     *time.Time      `json:"lastRunAt,omitempty"`
	LastSuccessAt *time.Time      `json:"lastSuccessAt,omitempty"`
	LastError     string          `json:"lastError,omitempty"`
	LastSummary   json.RawMessage `json:"lastSummary,omitempty"`
	PushPending   bool            `json:"pushPending"`
	CreatedAt     time.Time       `json:"createdAt"`
	UpdatedAt     time.Time       `json:"updatedAt"`
}

// ExportsRepo owns the export destinations and their manifests.
type ExportsRepo struct {
	db    Driver
	clock domain.Clock
}

const exportColumns = `id, kind, name, config_json, credential_enc, credential_ref, device_id, device_name, schedule, enabled, last_run_at, last_success_at, last_error, last_summary_json, push_pending, created_at, updated_at`

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

// Save inserts the destination (assigning its id) or updates its settings, and queues a Git
// destination to sync. Run state — last_run_at and the rest — is only ever written by RecordRun,
// which doesn't.
func (r *ExportsRepo) Save(d *ExportDestination) error {
	now := r.clock.Now().UTC()
	if len(d.Config) == 0 {
		d.Config = json.RawMessage(`{}`)
	}
	if d.ID == "" {
		d.ID = uuid.NewString()
		d.CreatedAt = now
	}
	d.UpdatedAt = now
	if _, err := r.db.Exec(
		`INSERT INTO export_destinations (id, kind, name, config_json, credential_enc, credential_ref, device_id, device_name, schedule, enabled, created_at, updated_at, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
		 ON CONFLICT(id) DO UPDATE SET name = excluded.name, config_json = excluded.config_json,
		   credential_enc = excluded.credential_enc, credential_ref = excluded.credential_ref,
		   device_id = excluded.device_id, device_name = excluded.device_name,
		   schedule = excluded.schedule, enabled = excluded.enabled,
		   updated_at = excluded.updated_at, dirty = 1;`,
		d.ID, d.Kind, d.Name, string(d.Config), nullString(d.CredentialEnc), d.CredentialRef, d.DeviceID, d.DeviceName, d.Schedule, boolToInt(d.Enabled),
		d.CreatedAt.Format(timeFormat), now.Format(timeFormat)); err != nil {
		return fmt.Errorf("save export destination: %w", err)
	}
	return nil
}

// RecordRun stores how a run went. A nil success leaves last_success_at as it was.
func (r *ExportsRepo) RecordRun(id string, ranAt time.Time, success *time.Time, lastError string, summary json.RawMessage, pushPending bool) error {
	if _, err := r.db.Exec(
		`UPDATE export_destinations SET last_run_at = ?, last_success_at = COALESCE(?, last_success_at),
		   last_error = ?, last_summary_json = CASE WHEN ? = '' THEN last_summary_json ELSE ? END, push_pending = ?
		 WHERE id = ?;`,
		ranAt.UTC().Format(timeFormat), nullTime(success), lastError, string(summary), string(summary), boolToInt(pushPending), id); err != nil {
		return fmt.Errorf("record export run: %w", err)
	}
	return nil
}

// Delete removes the destination and its manifest. What it exported stays where it is. A folder
// destination just goes; a Git one leaves a tombstone — credential wiped — so the deletion
// reaches the other devices.
func (r *ExportsRepo) Delete(id string) error {
	if _, err := r.db.Exec(`DELETE FROM export_manifest WHERE destination_id = ?;`, id); err != nil {
		return fmt.Errorf("delete export manifest: %w", err)
	}
	now := r.clock.Now().UTC().Format(timeFormat)
	if _, err := r.db.Exec(
		`UPDATE export_destinations SET deleted_at = ?, updated_at = ?, credential_enc = NULL, credential_ref = '', dirty = 1
		 WHERE id = ? AND kind = ? AND deleted_at IS NULL;`, now, now, id, ExportKindGit); err != nil {
		return fmt.Errorf("delete export destination: %w", err)
	}
	if _, err := r.db.Exec(`DELETE FROM export_destinations WHERE id = ? AND kind <> ?;`, id, ExportKindGit); err != nil {
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
			d                    ExportDestination
			config, summary      string
			enabled, pushPending int
			lastRun, lastSuccess sql.NullString
			credentialEnc        sql.NullString
			createdAt, updatedAt string
		)
		if err := rows.Scan(&d.ID, &d.Kind, &d.Name, &config, &credentialEnc, &d.CredentialRef, &d.DeviceID, &d.DeviceName, &d.Schedule, &enabled, &lastRun, &lastSuccess, &d.LastError, &summary, &pushPending, &createdAt, &updatedAt); err != nil {
			return nil, fmt.Errorf("scan export destination: %w", err)
		}
		d.CredentialEnc = credentialEnc.String
		d.Config = json.RawMessage(config)
		if summary != "" {
			d.LastSummary = json.RawMessage(summary)
		}
		d.Enabled, d.PushPending = enabled != 0, pushPending != 0
		if lastRun.Valid {
			if t, err := time.Parse(timeFormat, lastRun.String); err == nil {
				d.LastRunAt = &t
			}
		}
		if lastSuccess.Valid {
			if t, err := time.Parse(timeFormat, lastSuccess.String); err == nil {
				d.LastSuccessAt = &t
			}
		}
		d.CreatedAt, _ = time.Parse(timeFormat, createdAt)
		d.UpdatedAt, _ = time.Parse(timeFormat, updatedAt)
		out = append(out, &d)
	}
	return out, rows.Err()
}

// ---- sync (git destinations) ------------------------------------------------------------

// Git is the repo's face to the sync engine: the Git destinations in export_destinations, as
// domain.GitExport rows. Folder destinations share the table and are invisible here.
func (r *ExportsRepo) Git() *GitExportsSync { return &GitExportsSync{r} }

// GitExportsSync implements sync.SyncableRepo[*domain.GitExport].
type GitExportsSync struct{ r *ExportsRepo }

const gitExportColumns = `id, name, config_json, credential_enc, schedule, enabled, device_id, device_name, created_at, updated_at, deleted_at, version, dirty`

func (g *GitExportsSync) EntityType() string { return protocol.EntityGitExport }

func (g *GitExportsSync) Dirty() ([]*domain.GitExport, error) {
	return g.query(`SELECT `+gitExportColumns+` FROM export_destinations WHERE dirty = 1 AND kind = ? ORDER BY updated_at, id;`, ExportKindGit)
}

func (g *GitExportsSync) GetAny(id string) (*domain.GitExport, error) {
	out, err := g.query(`SELECT `+gitExportColumns+` FROM export_destinations WHERE id = ? AND kind = ?;`, id, ExportKindGit)
	if err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, ErrNotFound
	}
	return out[0], nil
}

// Apply overwrites the synced half of the row with the server's copy and clears dirty. This
// device's run state and secret-store ref are left alone — except that a credential arriving in
// the row supersedes a local ref, and a tombstone takes the manifest with it.
func (g *GitExportsSync) Apply(e *domain.GitExport) error {
	if err := e.Validate(); err != nil {
		return err
	}
	config := string(e.Config)
	if config == "" {
		config = "{}"
	}
	var credential any
	if e.CredentialEnc != nil && *e.CredentialEnc != "" {
		credential = *e.CredentialEnc
	}
	if _, err := g.r.db.Exec(
		`INSERT INTO export_destinations (id, kind, name, config_json, credential_enc, schedule, enabled, device_id, device_name, created_at, updated_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET name = excluded.name, config_json = excluded.config_json,
		   credential_enc = excluded.credential_enc, schedule = excluded.schedule, enabled = excluded.enabled,
		   device_id = excluded.device_id, device_name = excluded.device_name, created_at = excluded.created_at,
		   updated_at = excluded.updated_at, deleted_at = excluded.deleted_at, version = excluded.version, dirty = 0;`,
		e.ID, ExportKindGit, e.Name, config, credential, e.Schedule, boolToInt(e.Enabled), e.DeviceID, e.DeviceName,
		e.CreatedAt.UTC().Format(timeFormat), e.UpdatedAt.UTC().Format(timeFormat), nullTime(e.DeletedAt), e.Version); err != nil {
		return fmt.Errorf("apply git export: %w", err)
	}
	if e.DeletedAt != nil {
		if err := g.r.ClearManifest(e.ID); err != nil {
			return fmt.Errorf("apply git export: %w", err)
		}
	}
	return nil
}

func (g *GitExportsSync) MarkPushed(id string, version int64) error {
	if _, err := g.r.db.Exec(`UPDATE export_destinations SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark git export pushed: %w", err)
	}
	return nil
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

func (g *GitExportsSync) query(q string, args ...any) ([]*domain.GitExport, error) {
	rows, err := g.r.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("query git exports: %w", err)
	}
	defer rows.Close()
	out := []*domain.GitExport{}
	for rows.Next() {
		var (
			e                     domain.GitExport
			config                string
			credential, deletedAt sql.NullString
			enabled, dirty        int
			createdAt, updatedAt  string
		)
		if err := rows.Scan(&e.ID, &e.Name, &config, &credential, &e.Schedule, &enabled, &e.DeviceID, &e.DeviceName, &createdAt, &updatedAt, &deletedAt, &e.Version, &dirty); err != nil {
			return nil, fmt.Errorf("scan git export: %w", err)
		}
		e.Config = json.RawMessage(config)
		if credential.Valid && credential.String != "" {
			e.CredentialEnc = &credential.String
		}
		e.Enabled, e.Dirty = enabled != 0, dirty != 0
		e.CreatedAt, _ = time.Parse(timeFormat, createdAt)
		e.UpdatedAt, _ = time.Parse(timeFormat, updatedAt)
		if deletedAt.Valid {
			if t, err := time.Parse(timeFormat, deletedAt.String); err == nil {
				e.DeletedAt = &t
			}
		}
		out = append(out, &e)
	}
	return out, rows.Err()
}
