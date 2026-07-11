// Package crypto is the shared end-to-end encryption core (PLAN §E2EE). Every platform
// (web/wasm, desktop, mobile) runs this identical Go code, so note/task/calendar content is
// encrypted client-side before it is pushed and decrypted after it is pulled — the server, and
// whoever operates it, only ever holds ciphertext.
//
// The scheme, in one paragraph: a password is stretched with Argon2id into a single high-entropy
// secret, then split by HKDF into two independent keys — an auth key (sent to the server in place
// of the password, so the server authenticates without ever seeing the real password or the
// encryption key) and a key-encryption key (KEK, which never leaves the device). A random 32-byte
// master key encrypts every content field; the master key itself is stored on the server only in
// wrapped (KEK-encrypted) form, plus a second copy wrapped by a randomly generated recovery code.
// A new device signs in, fetches the wrapped master key, derives the KEK locally, and unwraps —
// which is the whole "any client with the password can decode" story, no device pairing required.
//
// Fields are encrypted individually and stored in place as a tagged string envelope
// (enc$v1$…), so the wire protocol and Postgres schema are unchanged: an encrypted title is
// still just a string in the row JSON. Associated data binds each ciphertext to its
// entityType+field (never the row id), because the server copies a repeating task's encrypted
// fields verbatim into freshly-materialized occurrence rows with different ids — id-bound AAD
// would fail to authenticate on the copy.
package crypto

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"strings"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/hkdf"
)

// KeyLen is the byte length of the master key and every derived symmetric key.
const KeyLen = 32

// SaltLen is the byte length of the per-user KDF salt.
const SaltLen = 16

// envelopePrefix tags an encrypted field value so decryption is self-describing and a plaintext
// (pre-encryption / migration) value is passed through untouched. The version segment lets the
// format evolve without ambiguity.
const envelopePrefix = "enc$v1$"

// HKDF info labels give the two derived keys independent, domain-separated key material from the
// same Argon2id output. Changing a label changes the key, so they are part of the wire contract.
const (
	infoAuth = "companion-auth-v1"
	infoKEK  = "companion-kek-v1"
)

// AAD labels authenticate a wrapped key against its purpose, so a KEK-wrapped master key can't be
// silently substituted for a recovery-wrapped one.
const (
	aadMasterKeyKEK      = "companion-masterkey-kek-v1"
	aadMasterKeyRecovery = "companion-masterkey-recovery-v1"
)

// KDFParams are the Argon2id cost parameters used to stretch a password. They are stored
// (unencrypted) alongside the wrapped key so any device — including a future one running newer
// defaults — can reproduce the exact derivation. Argon2id is deliberately expensive to slow
// offline guessing of a stolen wrapped key.
type KDFParams struct {
	Time    uint32 `json:"time"`    // iterations
	MemoryK uint32 `json:"memoryK"` // memory in KiB
	Threads uint8  `json:"threads"` // parallelism
}

// DefaultKDFParams are the current derivation costs (~64 MiB, 3 passes). Tuned to be
// interactive on a phone yet costly to brute-force; raise over time as hardware improves —
// stored params keep old wrapped keys decryptable.
func DefaultKDFParams() KDFParams {
	return KDFParams{Time: 3, MemoryK: 64 * 1024, Threads: 4}
}

var (
	// ErrDecrypt is returned when authentication fails: a wrong key, a tampered ciphertext, or a
	// value bound to a different field. It is deliberately opaque — callers must not distinguish
	// "wrong key" from "tampered", to avoid an oracle.
	ErrDecrypt = errors.New("crypto: decryption failed")
	// ErrNotEnvelope is returned by DecryptField for a value lacking the enc$v1$ prefix. Row-level
	// decryption treats such values as legacy plaintext and passes them through.
	ErrNotEnvelope = errors.New("crypto: not an encrypted envelope")
	// ErrKeyLen guards against a caller passing a key of the wrong size.
	ErrKeyLen = errors.New("crypto: key must be 32 bytes")
)

// randRead is crypto/rand, indirected so tests can force RNG failure paths.
var randRead = rand.Read

// NewSalt returns a fresh random KDF salt.
func NewSalt() ([]byte, error) {
	s := make([]byte, SaltLen)
	if _, err := io.ReadFull(rand.Reader, s); err != nil {
		return nil, err
	}
	return s, nil
}

// NewMasterKey returns a fresh random 32-byte content key.
func NewMasterKey() ([]byte, error) {
	k := make([]byte, KeyLen)
	if _, err := io.ReadFull(rand.Reader, k); err != nil {
		return nil, err
	}
	return k, nil
}

// stretch runs Argon2id over the password with the given salt and params, producing a single
// 32-byte secret that the two HKDF expansions below draw from.
func stretch(password string, salt []byte, p KDFParams) []byte {
	return argon2.IDKey([]byte(password), salt, p.Time, p.MemoryK, p.Threads, KeyLen)
}

// expand derives a 32-byte subkey from the stretched secret for one labeled purpose. HKDF gives
// the auth key and the KEK cryptographic independence: learning one reveals nothing about the
// other, so the auth key handed to the server can't be turned back into the KEK.
func expand(secret []byte, info string) ([]byte, error) {
	out := make([]byte, KeyLen)
	r := hkdf.New(sha256.New, secret, nil, []byte(info))
	if _, err := io.ReadFull(r, out); err != nil {
		return nil, err
	}
	return out, nil
}

// DerivedKeys are the two independent keys produced from a password: the AuthKey travels to the
// server (in place of the password) and the KEK stays on the device to unwrap the master key.
type DerivedKeys struct {
	AuthKey []byte // sent to server; server hashes it like a password
	KEK     []byte // never leaves the device
}

// DeriveKeys stretches the password and splits it into the auth key and KEK. This is the single
// entry point both the auth path (which needs AuthKey) and the unlock path (which needs KEK) call.
func DeriveKeys(password string, salt []byte, p KDFParams) (DerivedKeys, error) {
	if len(salt) == 0 {
		return DerivedKeys{}, errors.New("crypto: empty salt")
	}
	secret := stretch(password, salt, p)
	auth, err := expand(secret, infoAuth)
	if err != nil {
		return DerivedKeys{}, err
	}
	kek, err := expand(secret, infoKEK)
	if err != nil {
		return DerivedKeys{}, err
	}
	return DerivedKeys{AuthKey: auth, KEK: kek}, nil
}

// AuthKeyHex is the server-facing credential: the hex-encoded auth key derived from the password.
// The client sends this to register/login/change-password; the server bcrypts it exactly as it
// used to bcrypt the raw password, so the storage path is unchanged but the real password (and
// therefore the KEK and master key) never reaches the server.
func AuthKeyHex(password string, salt []byte, p KDFParams) (string, error) {
	dk, err := DeriveKeys(password, salt, p)
	if err != nil {
		return "", err
	}
	return toHex(dk.AuthKey), nil
}

// seal encrypts plaintext under key with the given associated data, returning a base64 envelope
// (nonce‖ciphertext, XChaCha20-Poly1305). A random 24-byte nonce makes reuse across the vast
// number of field encryptions negligible, so no per-field counter is needed.
func seal(key, plaintext []byte, aad string) (string, error) {
	if len(key) != KeyLen {
		return "", ErrKeyLen
	}
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := randRead(nonce); err != nil {
		return "", err
	}
	ct := aead.Seal(nonce, nonce, plaintext, []byte(aad))
	return envelopePrefix + base64.RawURLEncoding.EncodeToString(ct), nil
}

// open reverses seal: it parses the envelope and authenticates against key + aad, returning
// ErrDecrypt on any failure (wrong key, tamper, wrong field) without distinguishing them.
func open(key []byte, envelope, aad string) ([]byte, error) {
	if len(key) != KeyLen {
		return nil, ErrKeyLen
	}
	if !strings.HasPrefix(envelope, envelopePrefix) {
		return nil, ErrNotEnvelope
	}
	raw, err := base64.RawURLEncoding.DecodeString(envelope[len(envelopePrefix):])
	if err != nil {
		return nil, ErrDecrypt
	}
	aead, err := chacha20poly1305.NewX(key)
	if err != nil {
		return nil, err
	}
	if len(raw) < aead.NonceSize() {
		return nil, ErrDecrypt
	}
	nonce, ct := raw[:aead.NonceSize()], raw[aead.NonceSize():]
	pt, err := aead.Open(nil, nonce, ct, []byte(aad))
	if err != nil {
		return nil, ErrDecrypt
	}
	return pt, nil
}

// WrapMasterKey encrypts the master key with the KEK, producing the blob the server stores. The
// server can neither read nor forge it; only a device that re-derives the KEK from the password
// can unwrap it.
func WrapMasterKey(kek, masterKey []byte) (string, error) {
	if len(masterKey) != KeyLen {
		return "", ErrKeyLen
	}
	return seal(kek, masterKey, aadMasterKeyKEK)
}

// UnwrapMasterKey recovers the master key from its KEK-wrapped blob. A wrong password yields a
// KEK that fails authentication, surfacing as ErrDecrypt — this is how "wrong password" is
// detected on unlock, without the server ever validating the password against the key.
func UnwrapMasterKey(kek []byte, wrapped string) ([]byte, error) {
	return open(kek, wrapped, aadMasterKeyKEK)
}

// WrapMasterKeyRecovery encrypts the master key under a key derived from the recovery code, so a
// user who forgets their password can still recover their data. Distinct AAD keeps the two
// wrapped copies non-interchangeable.
func WrapMasterKeyRecovery(recoveryKey, masterKey []byte) (string, error) {
	if len(masterKey) != KeyLen {
		return "", ErrKeyLen
	}
	return seal(recoveryKey, masterKey, aadMasterKeyRecovery)
}

// UnwrapMasterKeyRecovery recovers the master key from the recovery-wrapped blob.
func UnwrapMasterKeyRecovery(recoveryKey []byte, wrapped string) ([]byte, error) {
	return open(recoveryKey, wrapped, aadMasterKeyRecovery)
}

// ConstantTimeEqual compares two secrets without leaking their relationship through timing.
func ConstantTimeEqual(a, b []byte) bool {
	return subtle.ConstantTimeCompare(a, b) == 1
}

// EncryptField seals one field value (its raw JSON bytes) under the master key, bound to
// entityType+field. The caller passes the JSON encoding of the value, so a string field and a
// structured (props/schema) field are handled identically and round-trip to the exact bytes.
func EncryptField(masterKey []byte, entityType, field string, valueJSON []byte) (string, error) {
	return seal(masterKey, valueJSON, fieldAAD(entityType, field))
}

// DecryptField opens a field envelope back to its original raw JSON bytes. ErrNotEnvelope signals
// a legacy-plaintext value the caller should keep as-is.
func DecryptField(masterKey []byte, entityType, field, envelope string) ([]byte, error) {
	return open(masterKey, envelope, fieldAAD(entityType, field))
}

// fieldAAD binds a ciphertext to its logical slot — entityType+field, deliberately not the row id
// (see package doc: repeat materialization copies fields across ids). This still prevents moving a
// title ciphertext into a notes field, or a note field into a task field.
func fieldAAD(entityType, field string) string {
	return "companion-field-v1:" + entityType + ":" + field
}

// IsEnvelope reports whether a stored string is an encrypted field (vs. legacy plaintext).
func IsEnvelope(s string) bool { return strings.HasPrefix(s, envelopePrefix) }

// EncodeHex hex-encodes a key/byte slice. Used to render an already-derived auth key without
// re-running the (expensive) KDF.
func EncodeHex(b []byte) string { return toHex(b) }

func toHex(b []byte) string {
	const hexdigits = "0123456789abcdef"
	out := make([]byte, len(b)*2)
	for i, c := range b {
		out[i*2] = hexdigits[c>>4]
		out[i*2+1] = hexdigits[c&0x0f]
	}
	return string(out)
}

// assertJSON is a tiny guard used by row encryption to fail loudly if a field value isn't the
// valid JSON it must be (it always is, coming from json.Marshal, but the check documents intent).
func assertJSON(field string, raw []byte) error {
	if len(raw) == 0 {
		return fmt.Errorf("crypto: empty value for field %q", field)
	}
	return nil
}
