package crypto

import (
	"encoding/json"

	"companion/core/sync/protocol"
)

// protectedFields lists, per entity type, the JSON field names whose values are encrypted before
// they leave the device. Everything omitted stays plaintext because the server needs it to
// function — scheduling (due_at, remind_at, repeat_rule), ordering, foreign keys, timestamps, and
// trash markers. See PLAN §E2EE for the field-by-field rationale; the short version is "content is
// encrypted, coordination metadata is not".
//
// Calendar is included: feeds carry the subscription url/icsText (a bearer secret) and events
// carry title/location/description, so a client-side fetch design (feeds fetched on-device, events
// pushed like any entity) keeps them opaque to the server.
var protectedFields = map[string][]string{
	protocol.EntityNote:          {"title", "contentMd", "props"},
	protocol.EntityTask:          {"title", "notesMd", "props"},
	protocol.EntityArea:          {"name"},
	protocol.EntityProject:       {"name"},
	protocol.EntityObjectType:    {"name", "schemaJson"},
	protocol.EntityDocument:      {"filename"},
	protocol.EntityChat:          {"title"},
	protocol.EntityChatMessage:   {"text", "toolCalls", "toolResults"},
	protocol.EntityCalendarFeed:  {"name", "url", "icsText"},
	protocol.EntityCalendarEvent: {"title", "location", "description", "icsUid"},
}

// ProtectedFields returns the encrypted field names for an entity type (nil if none). Exposed so
// the migration path and tests can enumerate exactly what gets encrypted.
func ProtectedFields(entityType string) []string { return protectedFields[entityType] }

// EncryptRow encrypts the protected fields of one marshaled entity row in place, returning the
// rewritten JSON. A field that is absent, JSON null, or already an envelope is left untouched, so
// the function is idempotent and safe to run over rows that mix encrypted and plaintext state
// (as happens mid-migration). Entity types with no protected fields pass straight through.
func EncryptRow(masterKey []byte, entityType string, row []byte) ([]byte, error) {
	fields := protectedFields[entityType]
	if len(fields) == 0 {
		return row, nil
	}
	obj, err := decodeRow(row)
	if err != nil {
		return nil, err
	}
	changed := false
	for _, f := range fields {
		raw, ok := obj[f]
		if !ok || isJSONNull(raw) || isEncryptedValue(raw) {
			continue
		}
		if err := assertJSON(f, raw); err != nil {
			return nil, err
		}
		env, err := EncryptField(masterKey, entityType, f, raw)
		if err != nil {
			return nil, err
		}
		enc, err := json.Marshal(env) // store the envelope as a JSON string value
		if err != nil {
			return nil, err
		}
		obj[f] = enc
		changed = true
	}
	if !changed {
		return row, nil
	}
	return json.Marshal(obj)
}

// DecryptRow reverses EncryptRow: every protected field holding an enc$v1$ envelope is restored to
// its original plaintext JSON bytes. A field that is plaintext (never encrypted, or a legacy row)
// is passed through, so a client reads mixed-state data transparently during migration.
func DecryptRow(masterKey []byte, entityType string, row []byte) ([]byte, error) {
	fields := protectedFields[entityType]
	if len(fields) == 0 {
		return row, nil
	}
	obj, err := decodeRow(row)
	if err != nil {
		return nil, err
	}
	changed := false
	for _, f := range fields {
		raw, ok := obj[f]
		if !ok || !isEncryptedValue(raw) {
			continue
		}
		var env string
		if err := json.Unmarshal(raw, &env); err != nil {
			return nil, err
		}
		plain, err := DecryptField(masterKey, entityType, f, env)
		if err != nil {
			return nil, err
		}
		obj[f] = json.RawMessage(plain)
		changed = true
	}
	if !changed {
		return row, nil
	}
	return json.Marshal(obj)
}

// decodeRow parses a row body into an ordered-agnostic field map. Object key order is irrelevant
// to both ends (each decodes by field name), so a map round-trip is safe.
func decodeRow(row []byte) (map[string]json.RawMessage, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(row, &obj); err != nil {
		return nil, err
	}
	return obj, nil
}

// isEncryptedValue reports whether a field's raw JSON is a string carrying an enc$v1$ envelope.
// Structured values (objects/arrays) and non-envelope strings return false.
func isEncryptedValue(raw json.RawMessage) bool {
	if len(raw) == 0 || raw[0] != '"' {
		return false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return false
	}
	return IsEnvelope(s)
}

func isJSONNull(raw json.RawMessage) bool {
	return string(raw) == "null"
}
