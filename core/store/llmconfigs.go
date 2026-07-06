package store

import (
	"database/sql"
	"fmt"
	"time"

	"companion/core/domain"

	"github.com/google/uuid"
)

// LLMConfigsRepo is the CRUD repository for LLM provider configs (PLAN §6.8). Device-scoped
// rows are local-only; account-scoped rows are eligible to sync (wired in a later step).
// The API key never lives here — only its keychain handle (api_key_ref).
type LLMConfigsRepo struct {
	db    Driver
	clock domain.Clock
}

const llmConfigColumns = `id, scope, name, base_url, provider, model, api_key_ref, is_default, created_at, updated_at, deleted_at, version, dirty`

// CreateLLMConfigInput carries the client-supplied fields for a new config. The API key is
// handled out of band (stored in the keychain by the bridge); only its ref reaches here.
type CreateLLMConfigInput struct {
	Scope     string  `json:"scope"`
	Name      string  `json:"name"`
	BaseURL   string  `json:"baseUrl"`
	Provider  string  `json:"provider"`
	Model     string  `json:"model"`
	APIKeyRef *string `json:"apiKeyRef,omitempty"`
	IsDefault bool    `json:"isDefault"`
}

// UpdateLLMConfigInput carries partial updates; nil fields are left unchanged.
type UpdateLLMConfigInput struct {
	Name      *string `json:"name,omitempty"`
	BaseURL   *string `json:"baseUrl,omitempty"`
	Model     *string `json:"model,omitempty"`
	APIKeyRef *string `json:"apiKeyRef,omitempty"`
}

// Create inserts a new config (UUIDv7 id, version 0, dirty). When IsDefault is set, it
// becomes the sole default.
func (r *LLMConfigsRepo) Create(in CreateLLMConfigInput) (*domain.LLMConfig, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return nil, fmt.Errorf("generate uuid: %w", err)
	}
	now := r.clock.Now().UTC()
	c := &domain.LLMConfig{
		ID: id.String(), Scope: in.Scope, Name: in.Name, BaseURL: in.BaseURL,
		Provider: in.Provider, Model: in.Model, APIKeyRef: in.APIKeyRef, IsDefault: in.IsDefault,
		CreatedAt: now, UpdatedAt: now, Version: 0, Dirty: true,
	}
	if err := c.Validate(); err != nil {
		return nil, err
	}
	if _, err := r.db.Exec(
		`INSERT INTO llm_configs (id, scope, name, base_url, provider, model, api_key_ref, is_default, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
		c.ID, c.Scope, c.Name, c.BaseURL, c.Provider, c.Model, c.APIKeyRef, boolToInt(c.IsDefault),
		c.CreatedAt.Format(timeFormat), c.UpdatedAt.Format(timeFormat), c.Version, boolToInt(c.Dirty),
	); err != nil {
		return nil, fmt.Errorf("insert llm config: %w", err)
	}
	if c.IsDefault {
		if err := r.clearOtherDefaults(c.ID); err != nil {
			return nil, err
		}
	}
	return c, nil
}

// Get returns a single non-deleted config by id, or ErrNotFound.
func (r *LLMConfigsRepo) Get(id string) (*domain.LLMConfig, error) {
	rows, err := r.db.Query(`SELECT `+llmConfigColumns+` FROM llm_configs WHERE id = ? AND deleted_at IS NULL;`, id)
	if err != nil {
		return nil, fmt.Errorf("query llm config: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanLLMConfig(rows)
}

// List returns all non-deleted configs, default first, then by name.
func (r *LLMConfigsRepo) List() ([]*domain.LLMConfig, error) {
	rows, err := r.db.Query(
		`SELECT ` + llmConfigColumns + ` FROM llm_configs WHERE deleted_at IS NULL ORDER BY is_default DESC, name, id;`)
	if err != nil {
		return nil, fmt.Errorf("query llm configs: %w", err)
	}
	defer rows.Close()
	out := []*domain.LLMConfig{}
	for rows.Next() {
		c, err := scanLLMConfig(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// Default returns the config flagged is_default, or ErrNotFound when none is set. When
// several somehow qualify (e.g. after a merge), the newest-updated wins.
func (r *LLMConfigsRepo) Default() (*domain.LLMConfig, error) {
	rows, err := r.db.Query(
		`SELECT ` + llmConfigColumns + ` FROM llm_configs WHERE deleted_at IS NULL AND is_default = 1 ORDER BY updated_at DESC, id DESC LIMIT 1;`)
	if err != nil {
		return nil, fmt.Errorf("query default llm config: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanLLMConfig(rows)
}

// Update applies partial changes, bumps updated_at, marks dirty.
func (r *LLMConfigsRepo) Update(id string, in UpdateLLMConfigInput) (*domain.LLMConfig, error) {
	c, err := r.Get(id)
	if err != nil {
		return nil, err
	}
	if in.Name != nil {
		c.Name = *in.Name
	}
	if in.BaseURL != nil {
		c.BaseURL = *in.BaseURL
	}
	if in.Model != nil {
		c.Model = *in.Model
	}
	if in.APIKeyRef != nil {
		c.APIKeyRef = in.APIKeyRef
	}
	c.UpdatedAt = r.clock.Now().UTC()
	c.Dirty = true
	if err := c.Validate(); err != nil {
		return nil, err
	}
	res, err := r.db.Exec(
		`UPDATE llm_configs SET name = ?, base_url = ?, model = ?, api_key_ref = ?, updated_at = ?, dirty = 1
		 WHERE id = ? AND deleted_at IS NULL;`,
		c.Name, c.BaseURL, c.Model, c.APIKeyRef, c.UpdatedAt.Format(timeFormat), id,
	)
	if err != nil {
		return nil, fmt.Errorf("update llm config: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return nil, ErrNotFound
	}
	return c, nil
}

// SetDefault makes id the sole default, clearing the flag on every other config.
func (r *LLMConfigsRepo) SetDefault(id string) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	res, err := r.db.Exec(
		`UPDATE llm_configs SET is_default = 1, updated_at = ?, dirty = 1 WHERE id = ? AND deleted_at IS NULL;`,
		now, id,
	)
	if err != nil {
		return fmt.Errorf("set default llm config: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	return r.clearOtherDefaults(id)
}

// clearOtherDefaults unsets is_default on every config except keepID.
func (r *LLMConfigsRepo) clearOtherDefaults(keepID string) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	if _, err := r.db.Exec(
		`UPDATE llm_configs SET is_default = 0, updated_at = ?, dirty = 1 WHERE id != ? AND is_default = 1 AND deleted_at IS NULL;`,
		now, keepID,
	); err != nil {
		return fmt.Errorf("clear other defaults: %w", err)
	}
	return nil
}

// Delete soft-deletes a config, marking it dirty so the tombstone syncs (for account rows).
func (r *LLMConfigsRepo) Delete(id string) error {
	now := r.clock.Now().UTC()
	res, err := r.db.Exec(
		`UPDATE llm_configs SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ? AND deleted_at IS NULL;`,
		now.Format(timeFormat), now.Format(timeFormat), id,
	)
	if err != nil {
		return fmt.Errorf("delete llm config: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	return nil
}

func scanLLMConfig(rows Rows) (*domain.LLMConfig, error) {
	var (
		c                    domain.LLMConfig
		apiKeyRef, deletedAt sql.NullString
		createdAt, updatedAt string
		isDefault, dirty     int
	)
	if err := rows.Scan(&c.ID, &c.Scope, &c.Name, &c.BaseURL, &c.Provider, &c.Model,
		&apiKeyRef, &isDefault, &createdAt, &updatedAt, &deletedAt, &c.Version, &dirty); err != nil {
		return nil, fmt.Errorf("scan llm config: %w", err)
	}
	if apiKeyRef.Valid {
		c.APIKeyRef = &apiKeyRef.String
	}
	var err error
	if c.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if c.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	if deletedAt.Valid {
		t, err := time.Parse(timeFormat, deletedAt.String)
		if err != nil {
			return nil, fmt.Errorf("parse deleted_at: %w", err)
		}
		c.DeletedAt = &t
	}
	c.IsDefault = isDefault != 0
	c.Dirty = dirty != 0
	return &c, nil
}
