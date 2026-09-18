package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"companion/core/domain"
	"companion/core/sync/protocol"

	"github.com/google/uuid"
)

// AgentsRepo is the CRUD + sync repository for installed agents (PLAN-agents.md §1). The
// table is still named llm_configs (its pre-agents name); the legacy scope/provider columns
// are written for compatibility and derived from the runtime + host.
type AgentsRepo struct {
	db    Driver
	clock domain.Clock
}

const agentColumns = `id, name, runtime, base_url, host_device_id, host_name, binary_path, binary_version,
	allow_write, allow_system, api_key_enc, api_key_ref, settings_json, is_default, created_at, updated_at, deleted_at, version, dirty`

// CreateAgentInput carries the client-supplied fields for a new agent. The API key is handled
// by the bridge (encrypted into APIKeyEnc on an E2EE account, or stored in the device secret
// store under APIKeyRef otherwise).
type CreateAgentInput struct {
	Name          string         `json:"name"`
	Runtime       domain.Runtime `json:"runtime"`
	BaseURL       string         `json:"baseUrl"`
	HostDeviceID  *string        `json:"hostDeviceId,omitempty"`
	HostName      *string        `json:"hostName,omitempty"`
	BinaryPath    *string        `json:"binaryPath,omitempty"`
	BinaryVersion *string        `json:"binaryVersion,omitempty"`
	// AllowWrite defaults to true when omitted (nil); AllowSystem defaults to false.
	AllowWrite   *bool   `json:"allowWrite,omitempty"`
	AllowSystem  bool    `json:"allowSystem"`
	APIKeyEnc    *string `json:"-"`
	APIKeyRef    *string `json:"-"`
	SettingsJSON string  `json:"settingsJson"`
	IsDefault    bool    `json:"isDefault"`
}

// UpdateAgentInput carries partial updates; nil fields are left unchanged.
type UpdateAgentInput struct {
	Name          *string `json:"name,omitempty"`
	BaseURL       *string `json:"baseUrl,omitempty"`
	AllowWrite    *bool   `json:"allowWrite,omitempty"`
	AllowSystem   *bool   `json:"allowSystem,omitempty"`
	SettingsJSON  *string `json:"settingsJson,omitempty"`
	BinaryPath    *string `json:"binaryPath,omitempty"`
	BinaryVersion *string `json:"binaryVersion,omitempty"`
	HostName      *string `json:"hostName,omitempty"`
	APIKeyEnc     *string `json:"-"`
	APIKeyRef     *string `json:"-"`
}

// Create inserts a new agent (UUIDv7 id, version 0, dirty). When IsDefault is set, it becomes
// the sole default. An empty BaseURL on an HTTP runtime takes the runtime's default endpoint.
func (r *AgentsRepo) Create(in CreateAgentInput) (*domain.Agent, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return nil, fmt.Errorf("generate uuid: %w", err)
	}
	now := r.clock.Now().UTC()
	if in.BaseURL == "" {
		in.BaseURL = in.Runtime.DefaultBaseURL()
	}
	if in.SettingsJSON == "" {
		in.SettingsJSON = "{}"
	}
	allowWrite := true
	if in.AllowWrite != nil {
		allowWrite = *in.AllowWrite
	}
	a := &domain.Agent{
		ID: id.String(), Name: in.Name, Runtime: in.Runtime, BaseURL: in.BaseURL,
		HostDeviceID: in.HostDeviceID, HostName: in.HostName,
		BinaryPath: in.BinaryPath, BinaryVersion: in.BinaryVersion, AllowWrite: allowWrite, AllowSystem: in.AllowSystem,
		APIKeyEnc: in.APIKeyEnc, APIKeyRef: in.APIKeyRef, SettingsJSON: in.SettingsJSON,
		IsDefault: in.IsDefault, CreatedAt: now, UpdatedAt: now, Version: 0, Dirty: true,
	}
	if err := a.Validate(); err != nil {
		return nil, err
	}
	if err := r.insert(a, boolToInt(true)); err != nil {
		return nil, err
	}
	if a.IsDefault {
		if err := r.clearOtherDefaults(a.ID); err != nil {
			return nil, err
		}
	}
	return a, nil
}

// insert writes a full row (used by Create and Apply); dirty is passed explicitly.
func (r *AgentsRepo) insert(a *domain.Agent, dirty int) error {
	var deletedAt any
	if a.DeletedAt != nil {
		deletedAt = a.DeletedAt.UTC().Format(timeFormat)
	}
	_, err := r.db.Exec(
		`INSERT INTO llm_configs (id, scope, name, base_url, provider, runtime, host_device_id, host_name, binary_path, binary_version,
		   allow_write, allow_system, api_key_enc, api_key_ref, settings_json, is_default, created_at, updated_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   scope = excluded.scope, name = excluded.name, base_url = excluded.base_url, provider = excluded.provider,
		   runtime = excluded.runtime, host_device_id = excluded.host_device_id, host_name = excluded.host_name,
		   binary_path = excluded.binary_path, binary_version = excluded.binary_version,
		   allow_write = excluded.allow_write, allow_system = excluded.allow_system,
		   api_key_enc = excluded.api_key_enc, api_key_ref = excluded.api_key_ref, settings_json = excluded.settings_json,
		   is_default = excluded.is_default, created_at = excluded.created_at, updated_at = excluded.updated_at,
		   deleted_at = excluded.deleted_at, version = excluded.version, dirty = excluded.dirty;`,
		a.ID, a.Scope(), a.Name, a.BaseURL, a.Runtime.WireProtocol(), string(a.Runtime), a.HostDeviceID, a.HostName,
		a.BinaryPath, a.BinaryVersion, boolToInt(a.AllowWrite), boolToInt(a.AllowSystem), a.APIKeyEnc, a.APIKeyRef, a.SettingsJSON,
		boolToInt(a.IsDefault), a.CreatedAt.UTC().Format(timeFormat), a.UpdatedAt.UTC().Format(timeFormat), deletedAt,
		a.Version, dirty,
	)
	if err != nil {
		return fmt.Errorf("insert agent: %w", err)
	}
	return nil
}

// Get returns a single non-deleted agent by id, or ErrNotFound.
func (r *AgentsRepo) Get(id string) (*domain.Agent, error) {
	rows, err := r.db.Query(`SELECT `+agentColumns+` FROM llm_configs WHERE id = ? AND deleted_at IS NULL;`, id)
	if err != nil {
		return nil, fmt.Errorf("query agent: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanAgent(rows)
}

// List returns all non-deleted agents, default first, then by name.
func (r *AgentsRepo) List() ([]*domain.Agent, error) {
	return r.list(`SELECT ` + agentColumns + ` FROM llm_configs WHERE deleted_at IS NULL ORDER BY is_default DESC, name, id;`)
}

func (r *AgentsRepo) list(q string, args ...any) ([]*domain.Agent, error) {
	rows, err := r.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("query agents: %w", err)
	}
	defer rows.Close()
	out := []*domain.Agent{}
	for rows.Next() {
		a, err := scanAgent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// Default returns the agent flagged is_default, or ErrNotFound when none is set. When several
// somehow qualify (e.g. after a merge), the newest-updated wins.
func (r *AgentsRepo) Default() (*domain.Agent, error) {
	rows, err := r.db.Query(
		`SELECT ` + agentColumns + ` FROM llm_configs WHERE deleted_at IS NULL AND is_default = 1 ORDER BY updated_at DESC, id DESC LIMIT 1;`)
	if err != nil {
		return nil, fmt.Errorf("query default agent: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanAgent(rows)
}

// Update applies partial changes, bumps updated_at, marks dirty.
func (r *AgentsRepo) Update(id string, in UpdateAgentInput) (*domain.Agent, error) {
	a, err := r.Get(id)
	if err != nil {
		return nil, err
	}
	if in.Name != nil {
		a.Name = *in.Name
	}
	if in.BaseURL != nil {
		a.BaseURL = *in.BaseURL
	}
	if in.AllowWrite != nil {
		a.AllowWrite = *in.AllowWrite
	}
	if in.AllowSystem != nil {
		a.AllowSystem = *in.AllowSystem
	}
	if in.SettingsJSON != nil {
		a.SettingsJSON = *in.SettingsJSON
	}
	if in.BinaryPath != nil {
		a.BinaryPath = in.BinaryPath
	}
	if in.BinaryVersion != nil {
		a.BinaryVersion = in.BinaryVersion
	}
	if in.HostName != nil {
		a.HostName = in.HostName
	}
	if in.APIKeyEnc != nil {
		a.APIKeyEnc = in.APIKeyEnc
	}
	if in.APIKeyRef != nil {
		a.APIKeyRef = in.APIKeyRef
	}
	a.UpdatedAt = r.clock.Now().UTC()
	a.Dirty = true
	if err := a.Validate(); err != nil {
		return nil, err
	}
	if err := r.insert(a, 1); err != nil {
		return nil, err
	}
	return a, nil
}

// SetDefault makes id the sole default, clearing the flag on every other agent.
func (r *AgentsRepo) SetDefault(id string) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	res, err := r.db.Exec(
		`UPDATE llm_configs SET is_default = 1, updated_at = ?, dirty = 1 WHERE id = ? AND deleted_at IS NULL;`, now, id)
	if err != nil {
		return fmt.Errorf("set default agent: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	return r.clearOtherDefaults(id)
}

// clearOtherDefaults unsets is_default on every agent except keepID.
func (r *AgentsRepo) clearOtherDefaults(keepID string) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	if _, err := r.db.Exec(
		`UPDATE llm_configs SET is_default = 0, updated_at = ?, dirty = 1 WHERE id != ? AND is_default = 1 AND deleted_at IS NULL;`,
		now, keepID); err != nil {
		return fmt.Errorf("clear other defaults: %w", err)
	}
	return nil
}

// Delete soft-deletes an agent, marking it dirty so the tombstone syncs.
func (r *AgentsRepo) Delete(id string) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	res, err := r.db.Exec(
		`UPDATE llm_configs SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ? AND deleted_at IS NULL;`, now, now, id)
	if err != nil {
		return fmt.Errorf("delete agent: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	return nil
}

// ClaimUnhosted assigns every legacy device-scoped row (a local runtime with no host) to
// deviceID/hostName. Run once at startup so pre-agents Ollama configs become agents hosted
// by the machine they were created on. Returns the number of rows claimed.
func (r *AgentsRepo) ClaimUnhosted(deviceID, hostName string) (int64, error) {
	if deviceID == "" {
		return 0, nil
	}
	now := r.clock.Now().UTC().Format(timeFormat)
	res, err := r.db.Exec(
		`UPDATE llm_configs SET host_device_id = ?, host_name = ?, updated_at = ?, dirty = 1
		 WHERE deleted_at IS NULL AND host_device_id IS NULL
		   AND (scope = 'device' OR runtime IN ('claude-cli', 'codex-cli', 'ollama', 'lmstudio'));`,
		deviceID, hostName, now)
	if err != nil {
		return 0, fmt.Errorf("claim unhosted agents: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// SetHostName refreshes the display name on every agent hosted by deviceID (after a rename).
func (r *AgentsRepo) SetHostName(deviceID, hostName string) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	if _, err := r.db.Exec(
		`UPDATE llm_configs SET host_name = ?, updated_at = ?, dirty = 1 WHERE host_device_id = ? AND deleted_at IS NULL;`,
		hostName, now, deviceID); err != nil {
		return fmt.Errorf("set host name: %w", err)
	}
	return nil
}

// --- SyncableRepo[*domain.Agent] (PLAN §7) ---------------------------------

func (r *AgentsRepo) EntityType() string { return protocol.EntityAgent }

func (r *AgentsRepo) Dirty() ([]*domain.Agent, error) {
	return r.list(`SELECT ` + agentColumns + ` FROM llm_configs WHERE dirty = 1 ORDER BY updated_at ASC, id ASC;`)
}

func (r *AgentsRepo) GetAny(id string) (*domain.Agent, error) {
	rows, err := r.db.Query(`SELECT `+agentColumns+` FROM llm_configs WHERE id = ?;`, id)
	if err != nil {
		return nil, fmt.Errorf("query agent: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanAgent(rows)
}

// Apply overwrites the local row with a server-canonical one and clears dirty.
func (r *AgentsRepo) Apply(a *domain.Agent) error {
	if a.SettingsJSON == "" {
		a.SettingsJSON = "{}"
	}
	return r.insert(a, 0)
}

func (r *AgentsRepo) MarkPushed(id string, version int64) error {
	if _, err := r.db.Exec(`UPDATE llm_configs SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark pushed: %w", err)
	}
	return nil
}

// MeaningfulDiff: agents are small config rows; server wins and nothing is forked, so this
// only matters for logging. Report a difference on any user-visible field.
func (r *AgentsRepo) MeaningfulDiff(a, b *domain.Agent) bool {
	if a.Name != b.Name || a.Runtime != b.Runtime || a.BaseURL != b.BaseURL || a.AllowWrite != b.AllowWrite || a.AllowSystem != b.AllowSystem {
		return true
	}
	if derefStr(a.HostDeviceID) != derefStr(b.HostDeviceID) || derefStr(a.APIKeyEnc) != derefStr(b.APIKeyEnc) {
		return true
	}
	if a.SettingsJSON != b.SettingsJSON || a.IsDefault != b.IsDefault {
		return true
	}
	return (a.DeletedAt == nil) != (b.DeletedAt == nil)
}

func (r *AgentsRepo) Decode(raw json.RawMessage) (*domain.Agent, error) {
	var a domain.Agent
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, fmt.Errorf("decode agent: %w", err)
	}
	return &a, nil
}

// ConflictedCopy is a no-op: an agent is a config row, not authored content; the server's
// version simply wins (like calendar events and canvas nodes).
func (r *AgentsRepo) ConflictedCopy(_ *domain.Agent, _ string) error { return nil }

func scanAgent(rows Rows) (*domain.Agent, error) {
	var (
		a                                                 domain.Agent
		runtime, createdAt, updatedAt                     string
		hostDeviceID, hostName, binaryPath, binaryVersion sql.NullString
		apiKeyEnc, apiKeyRef, deletedAt                   sql.NullString
		allowWrite, allowSystem, isDefault, dirty         int
	)
	if err := rows.Scan(&a.ID, &a.Name, &runtime, &a.BaseURL, &hostDeviceID, &hostName, &binaryPath, &binaryVersion,
		&allowWrite, &allowSystem, &apiKeyEnc, &apiKeyRef, &a.SettingsJSON, &isDefault, &createdAt, &updatedAt, &deletedAt, &a.Version, &dirty); err != nil {
		return nil, fmt.Errorf("scan agent: %w", err)
	}
	a.Runtime = domain.Runtime(runtime)
	a.HostDeviceID = nullStr(hostDeviceID)
	a.HostName = nullStr(hostName)
	a.BinaryPath = nullStr(binaryPath)
	a.BinaryVersion = nullStr(binaryVersion)
	a.APIKeyEnc = nullStr(apiKeyEnc)
	a.APIKeyRef = nullStr(apiKeyRef)
	var err error
	if a.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if a.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	if deletedAt.Valid {
		t, err := time.Parse(timeFormat, deletedAt.String)
		if err != nil {
			return nil, fmt.Errorf("parse deleted_at: %w", err)
		}
		a.DeletedAt = &t
	}
	a.AllowWrite = allowWrite != 0
	a.AllowSystem = allowSystem != 0
	a.IsDefault = isDefault != 0
	a.Dirty = dirty != 0
	return &a, nil
}

func nullStr(s sql.NullString) *string {
	if !s.Valid {
		return nil
	}
	v := s.String
	return &v
}
