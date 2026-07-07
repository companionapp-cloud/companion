package domain

import (
	"encoding/json"
	"errors"
	"testing"
)

func bookSchema() ObjectSchema {
	return ObjectSchema{Fields: []ObjectField{
		{Key: "author", Type: FieldReference, To: NodeNote, Label: "Author"},
		{Key: "rating", Type: FieldNumber, Label: "Rating"},
		{Key: "status", Type: FieldSelect, Options: []string{"to-read", "reading", "done"}, Required: true},
		{Key: "tags", Type: FieldMultiSelect, Options: []string{"fiction", "tech"}},
		{Key: "finished", Type: FieldDate},
		{Key: "recommended", Type: FieldCheckbox},
	}}
}

func TestObjectTypeValidate(t *testing.T) {
	schema, _ := json.Marshal(bookSchema())
	ok := &ObjectType{ID: "1", Name: "Book", AppliesTo: AppliesToNote, SchemaVersion: 1, SchemaJSON: schema}
	if err := ok.Validate(); err != nil {
		t.Fatalf("valid type rejected: %v", err)
	}

	cases := []struct {
		name string
		ot   *ObjectType
	}{
		{"no id", &ObjectType{Name: "Book", AppliesTo: AppliesToBoth}},
		{"no name", &ObjectType{ID: "1", AppliesTo: AppliesToBoth}},
		{"bad appliesTo", &ObjectType{ID: "1", Name: "Book", AppliesTo: "widget"}},
		{"unknown field type", &ObjectType{ID: "1", Name: "Book", AppliesTo: AppliesToBoth,
			SchemaJSON: mustJSON(ObjectSchema{Fields: []ObjectField{{Key: "x", Type: "blob"}}})}},
		{"select without options", &ObjectType{ID: "1", Name: "Book", AppliesTo: AppliesToBoth,
			SchemaJSON: mustJSON(ObjectSchema{Fields: []ObjectField{{Key: "s", Type: FieldSelect}}})}},
		{"duplicate keys", &ObjectType{ID: "1", Name: "Book", AppliesTo: AppliesToBoth,
			SchemaJSON: mustJSON(ObjectSchema{Fields: []ObjectField{{Key: "a", Type: FieldText}, {Key: "a", Type: FieldText}}})}},
	}
	for _, c := range cases {
		if err := c.ot.Validate(); err == nil {
			t.Errorf("%s: expected validation error", c.name)
		}
	}
}

func TestValidateProps(t *testing.T) {
	schema := bookSchema()

	// Valid: required present, types correct, options respected.
	valid := mustJSON(map[string]any{
		"author": "note-123", "rating": 4.5, "status": "reading",
		"tags": []string{"tech"}, "finished": "2026-01-02", "recommended": true,
	})
	if err := ValidateProps(valid, schema); err != nil {
		t.Fatalf("valid props rejected: %v", err)
	}

	// Extra keys are tolerated (schema can shed a field).
	if err := ValidateProps(mustJSON(map[string]any{"status": "done", "legacy": "x"}), schema); err != nil {
		t.Fatalf("extra key rejected: %v", err)
	}

	bad := map[string]json.RawMessage{
		"missing required":  mustJSON(map[string]any{"rating": 1}),
		"wrong number type": mustJSON(map[string]any{"status": "done", "rating": "high"}),
		"select not option": mustJSON(map[string]any{"status": "abandoned"}),
		"multi not option":  mustJSON(map[string]any{"status": "done", "tags": []string{"nope"}}),
		"bad date":          mustJSON(map[string]any{"status": "done", "finished": "01/02/2026"}),
		"checkbox not bool": mustJSON(map[string]any{"status": "done", "recommended": "yes"}),
	}
	for name, props := range bad {
		if err := ValidateProps(props, schema); !errors.Is(err, ErrInvalidProps) {
			t.Errorf("%s: expected ErrInvalidProps, got %v", name, err)
		}
	}
}

func TestPropRefs(t *testing.T) {
	schema := bookSchema()
	props := mustJSON(map[string]any{"author": "note-abc", "rating": 3, "status": "done"})
	refs := PropRefs(props, schema)
	if len(refs) != 1 {
		t.Fatalf("expected 1 prop ref, got %d: %+v", len(refs), refs)
	}
	got := refs[0]
	if got.TargetType != NodeNote || got.TargetID != "note-abc" || got.Kind != "prop:author" {
		t.Errorf("unexpected ref: %+v", got)
	}

	// Empty reference value yields no edge.
	if refs := PropRefs(mustJSON(map[string]any{"author": "", "status": "done"}), schema); len(refs) != 0 {
		t.Errorf("empty reference should yield no edge, got %+v", refs)
	}
}

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}
