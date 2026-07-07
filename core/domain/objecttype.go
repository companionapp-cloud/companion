package domain

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Object types (archetypes — PLAN §6.3). An object type turns a note or task into a
// structured object: notes/tasks carry an ObjectTypeID selecting the archetype and a
// PropsJSON blob of metadata; the type's SchemaJSON defines the fields, their
// validation, and how the form renderer displays them. Definitions sync like any other
// entity so archetypes stay consistent across devices.
//
// The rule (PLAN §6.3): TS decides what to *show*, Go decides what's *valid* — the
// validation below runs identically on the client write path and on the server push.

// AppliesTo values: an object type can archetype notes, tasks, or both.
const (
	AppliesToNote = "note"
	AppliesToTask = "task"
	AppliesToBoth = "both"
)

// Field types a schema may declare (PLAN §6.3). A `reference` field makes the object a
// graph participant: it produces a prop:<key> edge to the referenced node (see PropRefs).
const (
	FieldText        = "text"
	FieldNumber      = "number"
	FieldDate        = "date"
	FieldSelect      = "select"
	FieldMultiSelect = "multi_select"
	FieldReference   = "reference"
	FieldCheckbox    = "checkbox"
	FieldURL         = "url"
)

// ObjectType is an archetype definition. SchemaJSON is a versioned custom document (an
// envelope of {fields, rules?, steps?, layout?}), NOT JSON Schema (PLAN §6.3) — a flat
// field list today, with room reserved for conditional rules and multi-step forms.
type ObjectType struct {
	ID            string          `json:"id"`
	Name          string          `json:"name"`
	AppliesTo     string          `json:"appliesTo"` // note | task | both
	SchemaVersion int             `json:"schemaVersion"`
	SchemaJSON    json.RawMessage `json:"schemaJson"`
	CreatedAt     time.Time       `json:"createdAt"`
	UpdatedAt     time.Time       `json:"updatedAt"`
	DeletedAt     *time.Time      `json:"deletedAt,omitempty"`
	Version       int64           `json:"version"`
	Dirty         bool            `json:"dirty"`
}

// ObjectSchema is the parsed SchemaJSON envelope. Fields drives validation; Icon/Color
// are display config the clients render with (they're not validated here — display is a
// TS concern, PLAN §6.3). Rules/Steps/Layout are carried through untouched so the format
// can grow without a schema-version bump breaking older clients.
type ObjectSchema struct {
	Fields []ObjectField   `json:"fields"`
	Icon   string          `json:"icon,omitempty"`
	Color  string          `json:"color,omitempty"`
	Rules  json.RawMessage `json:"rules,omitempty"`
	Steps  json.RawMessage `json:"steps,omitempty"`
	Layout json.RawMessage `json:"layout,omitempty"`
}

// ObjectField is one flat field definition (PLAN §6.3): {key, type, label, required,
// options?, to?}. Options lists the choices for select/multi_select; To is the target
// node type for a reference field ("note" | "task" | "habit").
type ObjectField struct {
	Key      string   `json:"key"`
	Type     string   `json:"type"`
	Label    string   `json:"label,omitempty"`
	Required bool     `json:"required,omitempty"`
	Options  []string `json:"options,omitempty"`
	To       string   `json:"to,omitempty"`
}

// ErrInvalidObjectType is returned when an object type definition fails validation.
var ErrInvalidObjectType = errors.New("invalid object type")

// ErrInvalidProps is returned when an entity's props fail validation against its type.
var ErrInvalidProps = errors.New("invalid props")

// knownFieldTypes is the set of field types the validator understands.
var knownFieldTypes = map[string]bool{
	FieldText: true, FieldNumber: true, FieldDate: true, FieldSelect: true,
	FieldMultiSelect: true, FieldReference: true, FieldCheckbox: true, FieldURL: true,
}

// AppliesToKind reports whether an object type with the given appliesTo covers entities
// of the given node kind ("note" | "task").
func AppliesToKind(appliesTo, kind string) bool {
	return appliesTo == AppliesToBoth || appliesTo == kind
}

// Validate checks the invariants that must hold before an object type is persisted: an
// id, a name, a known appliesTo, and a well-formed schema (parseable, unique non-empty
// field keys, known field types, options present for select kinds, a target for
// references).
func (o *ObjectType) Validate() error {
	if strings.TrimSpace(o.ID) == "" {
		return errors.Join(ErrInvalidObjectType, errors.New("id is required"))
	}
	if strings.TrimSpace(o.Name) == "" {
		return errors.Join(ErrInvalidObjectType, errors.New("name is required"))
	}
	if !AppliesToKind(o.AppliesTo, AppliesToNote) && !AppliesToKind(o.AppliesTo, AppliesToTask) {
		return errors.Join(ErrInvalidObjectType, errors.New("appliesTo must be note, task, or both"))
	}
	schema, err := o.Schema()
	if err != nil {
		return errors.Join(ErrInvalidObjectType, err)
	}
	seen := map[string]bool{}
	for i, f := range schema.Fields {
		key := strings.TrimSpace(f.Key)
		if key == "" {
			return errors.Join(ErrInvalidObjectType, fmt.Errorf("field %d: key is required", i))
		}
		if seen[key] {
			return errors.Join(ErrInvalidObjectType, fmt.Errorf("duplicate field key %q", key))
		}
		seen[key] = true
		if !knownFieldTypes[f.Type] {
			return errors.Join(ErrInvalidObjectType, fmt.Errorf("field %q: unknown type %q", key, f.Type))
		}
		if (f.Type == FieldSelect || f.Type == FieldMultiSelect) && len(f.Options) == 0 {
			return errors.Join(ErrInvalidObjectType, fmt.Errorf("field %q: %s requires options", key, f.Type))
		}
		if f.Type == FieldReference && f.To != "" && !linkTypes[f.To] {
			return errors.Join(ErrInvalidObjectType, fmt.Errorf("field %q: reference target %q is not a node type", key, f.To))
		}
	}
	return nil
}

// Schema parses the type's SchemaJSON. An empty SchemaJSON is treated as an empty schema
// (no fields) so a type can exist before its fields are authored.
func (o *ObjectType) Schema() (ObjectSchema, error) {
	return ParseSchema(o.SchemaJSON)
}

// ParseSchema decodes a SchemaJSON envelope. Empty/nil input yields an empty schema.
func ParseSchema(raw json.RawMessage) (ObjectSchema, error) {
	var s ObjectSchema
	if len(raw) == 0 {
		return s, nil
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return s, fmt.Errorf("parse schema: %w", err)
	}
	return s, nil
}

// SyncEntity implementation (PLAN §7). Object types are deleted outright (tombstoned),
// not trashed.
func (o *ObjectType) SyncID() string           { return o.ID }
func (o *ObjectType) SyncVersion() int64       { return o.Version }
func (o *ObjectType) SyncUpdatedAt() time.Time { return o.UpdatedAt }
func (o *ObjectType) SyncDeleted() bool        { return o.DeletedAt != nil }
func (o *ObjectType) SyncDirty() bool          { return o.Dirty }

// ValidateProps checks an entity's PropsJSON against a schema (PLAN §6.3). It is
// tolerant of extra keys (a schema can shed a field without invalidating old rows) but
// strict about the fields it knows: required fields must be present and non-empty, and
// present values must match their declared type. Empty/nil props are valid only if no
// field is required.
func ValidateProps(rawProps json.RawMessage, schema ObjectSchema) error {
	props := map[string]json.RawMessage{}
	trimmed := strings.TrimSpace(string(rawProps))
	if trimmed != "" && trimmed != "{}" && trimmed != "null" {
		if err := json.Unmarshal(rawProps, &props); err != nil {
			return errors.Join(ErrInvalidProps, fmt.Errorf("props must be a JSON object: %w", err))
		}
	}
	for _, f := range schema.Fields {
		raw, present := props[f.Key]
		if !present || isJSONEmpty(raw) {
			if f.Required {
				return errors.Join(ErrInvalidProps, fmt.Errorf("field %q is required", f.Key))
			}
			continue
		}
		if err := validateFieldValue(f, raw); err != nil {
			return errors.Join(ErrInvalidProps, err)
		}
	}
	return nil
}

// validateFieldValue checks one present, non-empty value against its field definition.
func validateFieldValue(f ObjectField, raw json.RawMessage) error {
	switch f.Type {
	case FieldText, FieldURL, FieldReference, FieldDate:
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return fmt.Errorf("field %q: expected a string", f.Key)
		}
		if f.Type == FieldDate && strings.TrimSpace(s) != "" {
			if _, err := time.Parse("2006-01-02", s); err != nil {
				return fmt.Errorf("field %q: date must be YYYY-MM-DD", f.Key)
			}
		}
	case FieldNumber:
		var n float64
		if err := json.Unmarshal(raw, &n); err != nil {
			return fmt.Errorf("field %q: expected a number", f.Key)
		}
	case FieldCheckbox:
		var b bool
		if err := json.Unmarshal(raw, &b); err != nil {
			return fmt.Errorf("field %q: expected a boolean", f.Key)
		}
	case FieldSelect:
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return fmt.Errorf("field %q: expected a string", f.Key)
		}
		if !contains(f.Options, s) {
			return fmt.Errorf("field %q: %q is not one of the options", f.Key, s)
		}
	case FieldMultiSelect:
		var vals []string
		if err := json.Unmarshal(raw, &vals); err != nil {
			return fmt.Errorf("field %q: expected an array of strings", f.Key)
		}
		for _, v := range vals {
			if !contains(f.Options, v) {
				return fmt.Errorf("field %q: %q is not one of the options", f.Key, v)
			}
		}
	}
	return nil
}

// PropRefs extracts the derived graph edges carried by an entity's reference-typed props
// (PLAN §6.3, §5.1): each non-empty reference field yields a prop:<key> edge to the node
// it names. The target type comes from the field's To (defaulting to note). Deterministic
// by field order so the extraction matches a from-scratch rebuild.
func PropRefs(rawProps json.RawMessage, schema ObjectSchema) []Ref {
	if len(rawProps) == 0 {
		return nil
	}
	props := map[string]json.RawMessage{}
	if err := json.Unmarshal(rawProps, &props); err != nil {
		return nil
	}
	var out []Ref
	seen := map[Ref]bool{}
	for _, f := range schema.Fields {
		if f.Type != FieldReference {
			continue
		}
		raw, ok := props[f.Key]
		if !ok || isJSONEmpty(raw) {
			continue
		}
		var id string
		if err := json.Unmarshal(raw, &id); err != nil || strings.TrimSpace(id) == "" {
			continue
		}
		targetType := f.To
		if targetType == "" {
			targetType = NodeNote
		}
		r := Ref{TargetType: targetType, TargetID: id, Kind: PropKind(f.Key)}
		if seen[r] {
			continue
		}
		seen[r] = true
		out = append(out, r)
	}
	return out
}

// PropKind builds the edge kind for a reference prop field: "prop:<field>" (PLAN §4.1).
func PropKind(field string) string { return "prop:" + field }

// isJSONEmpty reports whether a raw JSON value is null, an empty string, an empty array,
// or empty — the cases the validator treats as "not provided".
func isJSONEmpty(raw json.RawMessage) bool {
	s := strings.TrimSpace(string(raw))
	return s == "" || s == "null" || s == `""` || s == "[]"
}

func contains(opts []string, v string) bool {
	for _, o := range opts {
		if o == v {
			return true
		}
	}
	return false
}
