package crypto

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"companion/core/sync/protocol"
)

// fastKDF keeps Argon2id cheap in tests; production uses DefaultKDFParams.
var fastKDF = KDFParams{Time: 1, MemoryK: 8 * 1024, Threads: 1}

func TestDeriveKeysDeterministicAndIndependent(t *testing.T) {
	salt, _ := NewSalt()
	a, err := DeriveKeys("correct horse", salt, fastKDF)
	if err != nil {
		t.Fatal(err)
	}
	b, err := DeriveKeys("correct horse", salt, fastKDF)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a.AuthKey, b.AuthKey) || !bytes.Equal(a.KEK, b.KEK) {
		t.Fatal("same password+salt must derive identical keys")
	}
	if bytes.Equal(a.AuthKey, a.KEK) {
		t.Fatal("auth key and KEK must be independent")
	}
	// A different password diverges both keys.
	c, _ := DeriveKeys("wrong horse", salt, fastKDF)
	if bytes.Equal(a.AuthKey, c.AuthKey) || bytes.Equal(a.KEK, c.KEK) {
		t.Fatal("different password must derive different keys")
	}
}

func TestAuthKeyHexHidesPassword(t *testing.T) {
	salt, _ := NewSalt()
	hexKey, err := AuthKeyHex("hunter2", salt, fastKDF)
	if err != nil {
		t.Fatal(err)
	}
	if len(hexKey) != KeyLen*2 {
		t.Fatalf("auth key hex len = %d, want %d", len(hexKey), KeyLen*2)
	}
	if strings.Contains(hexKey, "hunter2") {
		t.Fatal("auth key must not contain the password")
	}
}

func TestMasterKeyWrapRoundTrip(t *testing.T) {
	salt, _ := NewSalt()
	dk, _ := DeriveKeys("pw", salt, fastKDF)
	mk, _ := NewMasterKey()

	wrapped, err := WrapMasterKey(dk.KEK, mk)
	if err != nil {
		t.Fatal(err)
	}
	if !IsEnvelope(wrapped) {
		t.Fatal("wrapped key should be an envelope")
	}
	got, err := UnwrapMasterKey(dk.KEK, wrapped)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, mk) {
		t.Fatal("unwrapped master key mismatch")
	}
}

func TestUnwrapWrongPasswordFails(t *testing.T) {
	salt, _ := NewSalt()
	good, _ := DeriveKeys("right", salt, fastKDF)
	bad, _ := DeriveKeys("wrong", salt, fastKDF)
	mk, _ := NewMasterKey()
	wrapped, _ := WrapMasterKey(good.KEK, mk)

	if _, err := UnwrapMasterKey(bad.KEK, wrapped); !errors.Is(err, ErrDecrypt) {
		t.Fatalf("wrong password should yield ErrDecrypt, got %v", err)
	}
}

func TestRecoveryWrapRoundTripAndSeparation(t *testing.T) {
	mk, _ := NewMasterKey()
	code, err := NewRecoveryCode()
	if err != nil {
		t.Fatal(err)
	}
	rk, _ := RecoveryKey(code)
	wrapped, err := WrapMasterKeyRecovery(rk, mk)
	if err != nil {
		t.Fatal(err)
	}
	// A code re-typed with display grouping still recovers.
	grouped := groupForDisplay(code)
	rk2, _ := RecoveryKey(grouped)
	got, err := UnwrapMasterKeyRecovery(rk2, wrapped)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, mk) {
		t.Fatal("recovery unwrap mismatch")
	}
	// The recovery blob must not open as a KEK blob (distinct AAD).
	if _, err := UnwrapMasterKey(rk, wrapped); !errors.Is(err, ErrDecrypt) {
		t.Fatal("recovery-wrapped key must not open via KEK path")
	}
}

func TestFieldEncryptRoundTrip(t *testing.T) {
	mk, _ := NewMasterKey()
	plain := json.RawMessage(`"my secret title"`)
	env, err := EncryptField(mk, protocol.EntityNote, "title", plain)
	if err != nil {
		t.Fatal(err)
	}
	if !IsEnvelope(env) || strings.Contains(env, "secret") {
		t.Fatalf("envelope leaks plaintext or lacks prefix: %q", env)
	}
	got, err := DecryptField(mk, protocol.EntityNote, "title", env)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, plain) {
		t.Fatalf("round trip mismatch: %s != %s", got, plain)
	}
}

func TestFieldAADBinding(t *testing.T) {
	mk, _ := NewMasterKey()
	plain := json.RawMessage(`"value"`)
	env, _ := EncryptField(mk, protocol.EntityNote, "title", plain)

	// Same key, wrong field slot → must not authenticate.
	if _, err := DecryptField(mk, protocol.EntityNote, "contentMd", env); !errors.Is(err, ErrDecrypt) {
		t.Fatal("field-swapped decryption should fail")
	}
	// Same key, wrong entity type → must not authenticate.
	if _, err := DecryptField(mk, protocol.EntityTask, "title", env); !errors.Is(err, ErrDecrypt) {
		t.Fatal("entity-swapped decryption should fail")
	}
}

func TestTamperDetected(t *testing.T) {
	mk, _ := NewMasterKey()
	env, _ := EncryptField(mk, protocol.EntityNote, "title", json.RawMessage(`"x"`))
	// Flip a character in the base64 body.
	b := []byte(env)
	b[len(b)-1] ^= 0x01
	if _, err := DecryptField(mk, protocol.EntityNote, "title", string(b)); !errors.Is(err, ErrDecrypt) {
		t.Fatal("tampered ciphertext should fail authentication")
	}
}

func TestEncryptRowNoteAndDecrypt(t *testing.T) {
	mk, _ := NewMasterKey()
	row := []byte(`{"id":"n1","title":"Groceries","contentMd":"# milk","date":"2026-07-11","props":{"rating":5},"version":2}`)

	enc, err := EncryptRow(mk, protocol.EntityNote, row)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(enc, &m); err != nil {
		t.Fatal(err)
	}
	// Protected fields are now envelope strings; plaintext gone.
	for _, f := range []string{"title", "contentMd", "props"} {
		if !isEncryptedValue(m[f]) {
			t.Fatalf("field %q not encrypted: %s", f, m[f])
		}
	}
	if strings.Contains(string(enc), "Groceries") || strings.Contains(string(enc), "milk") || strings.Contains(string(enc), "rating") {
		t.Fatal("plaintext content leaked into encrypted row")
	}
	// Non-protected coordination fields stay readable.
	if string(m["id"]) != `"n1"` || string(m["date"]) != `"2026-07-11"` || string(m["version"]) != `2` {
		t.Fatal("coordination fields must remain plaintext")
	}

	dec, err := DecryptRow(mk, protocol.EntityNote, enc)
	if err != nil {
		t.Fatal(err)
	}
	assertJSONEqual(t, row, dec)
}

func TestEncryptRowIdempotent(t *testing.T) {
	mk, _ := NewMasterKey()
	row := []byte(`{"id":"n1","title":"T","contentMd":"C","version":1}`)
	once, _ := EncryptRow(mk, protocol.EntityNote, row)
	twice, err := EncryptRow(mk, protocol.EntityNote, once)
	if err != nil {
		t.Fatal(err)
	}
	// Second pass must not double-encrypt (already-envelope fields are skipped), so a decrypt
	// still yields the original.
	dec, _ := DecryptRow(mk, protocol.EntityNote, twice)
	assertJSONEqual(t, row, dec)
}

func TestDecryptRowPlaintextPassthrough(t *testing.T) {
	mk, _ := NewMasterKey()
	// A legacy plaintext row (pre-encryption) must survive DecryptRow untouched.
	row := []byte(`{"id":"n1","title":"Legacy","contentMd":"still here","version":1}`)
	out, err := DecryptRow(mk, protocol.EntityNote, row)
	if err != nil {
		t.Fatal(err)
	}
	assertJSONEqual(t, row, out)
}

func TestEncryptRowSkipsNullAndAbsent(t *testing.T) {
	mk, _ := NewMasterKey()
	// props absent, title present but empty string, contentMd null.
	row := []byte(`{"id":"n1","title":"","contentMd":null,"version":1}`)
	enc, err := EncryptRow(mk, protocol.EntityNote, row)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]json.RawMessage
	json.Unmarshal(enc, &m)
	if !isEncryptedValue(m["title"]) {
		t.Fatal("empty-but-present title should still be encrypted (hides emptiness)")
	}
	if _, ok := m["props"]; ok {
		t.Fatal("absent field must not be materialized")
	}
	if string(m["contentMd"]) != "null" {
		t.Fatal("null field must be left as null")
	}
}

func TestUnknownEntityPassthrough(t *testing.T) {
	mk, _ := NewMasterKey()
	row := []byte(`{"id":"x","secret":"stays"}`)
	out, err := EncryptRow(mk, "not_a_real_entity", row)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(out, row) {
		t.Fatal("entity with no protected fields must pass through unchanged")
	}
}

func TestCalendarEventEncrypted(t *testing.T) {
	mk, _ := NewMasterKey()
	row := []byte(`{"id":"e1","feedId":"f1","title":"Dentist","location":"Main St","startsAt":"2026-07-11T09:00:00Z","allDay":false,"version":1}`)
	enc, err := EncryptRow(mk, protocol.EntityCalendarEvent, row)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(enc), "Dentist") || strings.Contains(string(enc), "Main St") {
		t.Fatal("calendar event content leaked")
	}
	if !strings.Contains(string(enc), `"startsAt":"2026-07-11T09:00:00Z"`) {
		t.Fatal("startsAt must remain plaintext for scheduling")
	}
	dec, _ := DecryptRow(mk, protocol.EntityCalendarEvent, enc)
	assertJSONEqual(t, row, dec)
}

// groupForDisplay mimics the UI formatting (groups of 4, hyphen-separated) that
// NormalizeRecoveryCode must undo.
func groupForDisplay(code string) string {
	var b strings.Builder
	for i, r := range code {
		if i > 0 && i%4 == 0 {
			b.WriteByte('-')
		}
		b.WriteRune(r)
	}
	return b.String()
}

func assertJSONEqual(t *testing.T, want, got []byte) {
	t.Helper()
	var wv, gv any
	if err := json.Unmarshal(want, &wv); err != nil {
		t.Fatalf("want not json: %v", err)
	}
	if err := json.Unmarshal(got, &gv); err != nil {
		t.Fatalf("got not json: %v", err)
	}
	wb, _ := json.Marshal(wv)
	gb, _ := json.Marshal(gv)
	if !bytes.Equal(wb, gb) {
		t.Fatalf("json mismatch:\n want %s\n got  %s", wb, gb)
	}
}
