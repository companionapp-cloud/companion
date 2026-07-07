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

// ObjectTypesRepo is the CRUD + sync repository for object types (archetypes — PLAN
// §6.3). Definitions sync like any other entity so archetypes stay consistent across
// devices; it also resolves schemas for the link extractor's prop:<field> edges via
// SchemaFor.
type ObjectTypesRepo struct {
	db    Driver
	clock domain.Clock
}

const objectTypeColumns = `id, name, applies_to, schema_version, schema_json, created_at, updated_at, deleted_at, version, dirty`

// CreateObjectTypeInput carries the client-supplied fields for a new object type.
type CreateObjectTypeInput struct {
	Name          string          `json:"name"`
	AppliesTo     string          `json:"appliesTo"` // note | task | both; defaults to both
	SchemaVersion int             `json:"schemaVersion"`
	SchemaJSON    json.RawMessage `json:"schemaJson"`
}

// UpdateObjectTypeInput carries partial updates; nil fields are left unchanged. Editing a
// type does NOT rewrite existing rows — validation applies on each row's next write and
// the form renderer tolerates missing/extra keys (PLAN §6.3).
type UpdateObjectTypeInput struct {
	Name          *string          `json:"name,omitempty"`
	AppliesTo     *string          `json:"appliesTo,omitempty"`
	SchemaVersion *int             `json:"schemaVersion,omitempty"`
	SchemaJSON    *json.RawMessage `json:"schemaJson,omitempty"`
}

// normalizeSchema returns the schema JSON to store, defaulting empty to "{}".
func normalizeSchema(raw json.RawMessage) string {
	if len(raw) == 0 {
		return "{}"
	}
	return string(raw)
}

// normalizeProps returns the props JSON to store, defaulting empty/null to "{}" so the
// props_json column (NOT NULL) always holds a valid object.
func normalizeProps(raw json.RawMessage) string {
	s := string(raw)
	if len(raw) == 0 || s == "null" {
		return "{}"
	}
	return s
}

// Create inserts a new object type (UUIDv7 id, version 0, dirty), defaulting appliesTo to
// "both" and schema_version to 1.
func (r *ObjectTypesRepo) Create(in CreateObjectTypeInput) (*domain.ObjectType, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return nil, fmt.Errorf("generate uuid: %w", err)
	}
	now := r.clock.Now().UTC()
	appliesTo := in.AppliesTo
	if appliesTo == "" {
		appliesTo = domain.AppliesToBoth
	}
	schemaVersion := in.SchemaVersion
	if schemaVersion == 0 {
		schemaVersion = 1
	}
	o := &domain.ObjectType{
		ID: id.String(), Name: in.Name, AppliesTo: appliesTo, SchemaVersion: schemaVersion,
		SchemaJSON: json.RawMessage(normalizeSchema(in.SchemaJSON)),
		CreatedAt:  now, UpdatedAt: now, Version: 0, Dirty: true,
	}
	if err := o.Validate(); err != nil {
		return nil, err
	}
	if _, err := r.db.Exec(
		`INSERT INTO object_types (id, name, applies_to, schema_version, schema_json, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
		o.ID, o.Name, o.AppliesTo, o.SchemaVersion, string(o.SchemaJSON),
		o.CreatedAt.Format(timeFormat), o.UpdatedAt.Format(timeFormat), o.Version, boolToInt(o.Dirty),
	); err != nil {
		return nil, fmt.Errorf("insert object type: %w", err)
	}
	return o, nil
}

// Get returns a single non-deleted object type by id, or ErrNotFound.
func (r *ObjectTypesRepo) Get(id string) (*domain.ObjectType, error) {
	rows, err := r.db.Query(`SELECT `+objectTypeColumns+` FROM object_types WHERE id = ? AND deleted_at IS NULL;`, id)
	if err != nil {
		return nil, fmt.Errorf("query object type: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanObjectType(rows)
}

// List returns all non-deleted object types, by name.
func (r *ObjectTypesRepo) List() ([]*domain.ObjectType, error) {
	rows, err := r.db.Query(
		`SELECT ` + objectTypeColumns + ` FROM object_types WHERE deleted_at IS NULL ORDER BY name, id;`)
	if err != nil {
		return nil, fmt.Errorf("query object types: %w", err)
	}
	defer rows.Close()
	out := []*domain.ObjectType{}
	for rows.Next() {
		o, err := scanObjectType(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// Update applies partial changes, bumps updated_at, marks dirty. Existing archetyped rows
// are not re-validated here (PLAN §6.3).
func (r *ObjectTypesRepo) Update(id string, in UpdateObjectTypeInput) (*domain.ObjectType, error) {
	o, err := r.Get(id)
	if err != nil {
		return nil, err
	}
	if in.Name != nil {
		o.Name = *in.Name
	}
	if in.AppliesTo != nil {
		o.AppliesTo = *in.AppliesTo
	}
	if in.SchemaVersion != nil {
		o.SchemaVersion = *in.SchemaVersion
	}
	if in.SchemaJSON != nil {
		o.SchemaJSON = json.RawMessage(normalizeSchema(*in.SchemaJSON))
	}
	o.UpdatedAt = r.clock.Now().UTC()
	o.Dirty = true
	if err := o.Validate(); err != nil {
		return nil, err
	}
	res, err := r.db.Exec(
		`UPDATE object_types SET name = ?, applies_to = ?, schema_version = ?, schema_json = ?,
		   updated_at = ?, dirty = 1
		 WHERE id = ? AND deleted_at IS NULL;`,
		o.Name, o.AppliesTo, o.SchemaVersion, string(o.SchemaJSON), o.UpdatedAt.Format(timeFormat), id,
	)
	if err != nil {
		return nil, fmt.Errorf("update object type: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return nil, ErrNotFound
	}
	return o, nil
}

// Delete soft-deletes (tombstones) an object type. Entities keep their object_type_id,
// which simply dangles — the same tolerance as a dangling wikilink (PLAN §5.1). Their
// props stay stored and render best-effort until the type is reassigned.
func (r *ObjectTypesRepo) Delete(id string) error {
	now := r.clock.Now().UTC()
	res, err := r.db.Exec(
		`UPDATE object_types SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE id = ? AND deleted_at IS NULL;`,
		now.Format(timeFormat), now.Format(timeFormat), id,
	)
	if err != nil {
		return fmt.Errorf("delete object type: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	return nil
}

// SchemaFor resolves a live object type's parsed schema for link extraction (implements
// schemaResolver). ok is false when the type is missing or tombstoned.
func (r *ObjectTypesRepo) SchemaFor(objectTypeID string) (domain.ObjectSchema, bool, error) {
	o, err := r.Get(objectTypeID)
	if err == ErrNotFound {
		return domain.ObjectSchema{}, false, nil
	}
	if err != nil {
		return domain.ObjectSchema{}, false, err
	}
	schema, err := o.Schema()
	if err != nil {
		return domain.ObjectSchema{}, false, err
	}
	return schema, true, nil
}

// ValidateEntityProps validates an archetyped entity's props against its type's schema
// (PLAN §6.3), running the identical Go rules the server applies on push. A nil/empty
// object_type_id is a plain note/task (no props to check); a dangling type (not synced
// yet) is tolerated — validation is skipped until the type arrives.
func (r *ObjectTypesRepo) ValidateEntityProps(objectTypeID *string, props json.RawMessage) error {
	if objectTypeID == nil || *objectTypeID == "" {
		return nil
	}
	schema, ok, err := r.SchemaFor(*objectTypeID)
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}
	return domain.ValidateProps(props, schema)
}

// --- SyncableRepo[*domain.ObjectType] -------------------------------------

func (r *ObjectTypesRepo) EntityType() string { return protocol.EntityObjectType }

func (r *ObjectTypesRepo) Dirty() ([]*domain.ObjectType, error) {
	rows, err := r.db.Query(`SELECT ` + objectTypeColumns + ` FROM object_types WHERE dirty = 1 ORDER BY updated_at ASC, id ASC;`)
	if err != nil {
		return nil, fmt.Errorf("query dirty object types: %w", err)
	}
	defer rows.Close()
	out := []*domain.ObjectType{}
	for rows.Next() {
		o, err := scanObjectType(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

func (r *ObjectTypesRepo) GetAny(id string) (*domain.ObjectType, error) {
	rows, err := r.db.Query(`SELECT `+objectTypeColumns+` FROM object_types WHERE id = ?;`, id)
	if err != nil {
		return nil, fmt.Errorf("query object type: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, ErrNotFound
	}
	return scanObjectType(rows)
}

func (r *ObjectTypesRepo) Apply(o *domain.ObjectType) error {
	var deletedAt any
	if o.DeletedAt != nil {
		deletedAt = o.DeletedAt.UTC().Format(timeFormat)
	}
	_, err := r.db.Exec(
		`INSERT INTO object_types (id, name, applies_to, schema_version, schema_json, created_at, updated_at, deleted_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
		 ON CONFLICT(id) DO UPDATE SET
		   name = excluded.name, applies_to = excluded.applies_to, schema_version = excluded.schema_version,
		   schema_json = excluded.schema_json, created_at = excluded.created_at,
		   updated_at = excluded.updated_at, deleted_at = excluded.deleted_at,
		   version = excluded.version, dirty = 0;`,
		o.ID, o.Name, o.AppliesTo, o.SchemaVersion, string(normalizeSchema(o.SchemaJSON)),
		o.CreatedAt.UTC().Format(timeFormat), o.UpdatedAt.UTC().Format(timeFormat), deletedAt, o.Version,
	)
	if err != nil {
		return fmt.Errorf("apply object type: %w", err)
	}
	return nil
}

func (r *ObjectTypesRepo) MarkPushed(id string, version int64) error {
	if _, err := r.db.Exec(`UPDATE object_types SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark pushed: %w", err)
	}
	return nil
}

func (r *ObjectTypesRepo) MeaningfulDiff(a, b *domain.ObjectType) bool {
	if a.Name != b.Name || a.AppliesTo != b.AppliesTo || a.SchemaVersion != b.SchemaVersion {
		return true
	}
	if string(normalizeSchema(a.SchemaJSON)) != string(normalizeSchema(b.SchemaJSON)) {
		return true
	}
	return (a.DeletedAt == nil) != (b.DeletedAt == nil)
}

func (r *ObjectTypesRepo) Decode(raw json.RawMessage) (*domain.ObjectType, error) {
	var o domain.ObjectType
	if err := json.Unmarshal(raw, &o); err != nil {
		return nil, fmt.Errorf("decode object type: %w", err)
	}
	return &o, nil
}

// ConflictedCopy forks a losing local object type into a fresh row (§7.3).
func (r *ObjectTypesRepo) ConflictedCopy(local *domain.ObjectType, suffix string) error {
	id, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("generate uuid: %w", err)
	}
	now := r.clock.Now().UTC()
	name := local.Name
	if name == "" {
		name = "Untitled"
	}
	_, err = r.db.Exec(
		`INSERT INTO object_types (id, name, applies_to, schema_version, schema_json, created_at, updated_at, version, dirty)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1);`,
		id.String(), name+" "+suffix, local.AppliesTo, local.SchemaVersion, string(normalizeSchema(local.SchemaJSON)),
		now.Format(timeFormat), now.Format(timeFormat),
	)
	if err != nil {
		return fmt.Errorf("insert conflicted object type: %w", err)
	}
	return nil
}

func scanObjectType(rows Rows) (*domain.ObjectType, error) {
	var (
		o                    domain.ObjectType
		schemaJSON           string
		deletedAt            sql.NullString
		createdAt, updatedAt string
		dirty                int
	)
	if err := rows.Scan(&o.ID, &o.Name, &o.AppliesTo, &o.SchemaVersion, &schemaJSON, &createdAt, &updatedAt, &deletedAt, &o.Version, &dirty); err != nil {
		return nil, fmt.Errorf("scan object type: %w", err)
	}
	o.SchemaJSON = json.RawMessage(schemaJSON)
	var err error
	if o.CreatedAt, err = time.Parse(timeFormat, createdAt); err != nil {
		return nil, fmt.Errorf("parse created_at: %w", err)
	}
	if o.UpdatedAt, err = time.Parse(timeFormat, updatedAt); err != nil {
		return nil, fmt.Errorf("parse updated_at: %w", err)
	}
	if deletedAt.Valid {
		t, err := time.Parse(timeFormat, deletedAt.String)
		if err != nil {
			return nil, fmt.Errorf("parse deleted_at: %w", err)
		}
		o.DeletedAt = &t
	}
	o.Dirty = dirty != 0
	return &o, nil
}
