package crypto

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"io"
	"strings"

	"golang.org/x/crypto/hkdf"
)

// Recovery codes let a user who forgets their password still decrypt their data (the master key
// is wrapped a second time under a key derived from the code). A password *reset* without this
// code is unrecoverable by design — the server has only ciphertext — so the code is shown once at
// setup and the UI must tell the user to store it safely.

// recoveryEncoding is Crockford-ish base32 without padding: uppercase, no 0/O/1/I ambiguity in
// display (we group and hyphenate for readability at the UI layer, not here).
var recoveryEncoding = base32.StdEncoding.WithPadding(base32.NoPadding)

// recoveryBytes is the entropy behind a recovery code: 20 bytes → 32 base32 chars, ample against
// brute force while staying short enough to write down.
const recoveryBytes = 20

// NewRecoveryCode returns a fresh high-entropy recovery code as an uppercase base32 string. The
// caller formats it for display (e.g. grouped in fours); NormalizeRecoveryCode reverses any such
// formatting before use.
func NewRecoveryCode() (string, error) {
	b := make([]byte, recoveryBytes)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		return "", err
	}
	return recoveryEncoding.EncodeToString(b), nil
}

// NormalizeRecoveryCode strips spaces, hyphens, and case so a code the user typed with the
// display grouping still derives the same key.
func NormalizeRecoveryCode(code string) string {
	r := strings.NewReplacer(" ", "", "-", "", "\t", "")
	return strings.ToUpper(r.Replace(strings.TrimSpace(code)))
}

// RecoveryKey derives the 32-byte wrapping key from a recovery code. The code is already
// high-entropy (unlike a password), so a plain HKDF-SHA256 expansion is sufficient — no Argon2id
// stretching is needed, and none is wanted, since recovery must work without stored KDF params.
func RecoveryKey(code string) ([]byte, error) {
	norm := NormalizeRecoveryCode(code)
	out := make([]byte, KeyLen)
	r := hkdf.New(sha256.New, []byte(norm), nil, []byte("companion-recovery-v1"))
	if _, err := io.ReadFull(r, out); err != nil {
		return nil, err
	}
	return out, nil
}
