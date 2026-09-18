package crypto

// Cipher binds a master key to the row encrypt/decrypt operations so the sync engine can hold one
// opaque object and stay unaware of key material. It satisfies the engine's RowCipher seam
// structurally; a nil *Cipher means "encryption disabled", handled by the engine as plaintext
// passthrough.
type Cipher struct {
	masterKey []byte
}

// NewCipher returns a Cipher over a 32-byte master key, or nil if the key is the wrong length
// (callers treat nil as "not unlocked" and sync in plaintext).
func NewCipher(masterKey []byte) *Cipher {
	if len(masterKey) != KeyLen {
		return nil
	}
	// Copy so a caller zeroing its buffer can't neuter an in-flight sync.
	k := make([]byte, KeyLen)
	copy(k, masterKey)
	return &Cipher{masterKey: k}
}

// EncryptRow encrypts a marshaled row's protected fields before push.
func (c *Cipher) EncryptRow(entityType string, row []byte) ([]byte, error) {
	return EncryptRow(c.masterKey, entityType, row)
}

// DecryptRow restores a pulled row's protected fields after fetch.
func (c *Cipher) DecryptRow(entityType string, row []byte) ([]byte, error) {
	return DecryptRow(c.masterKey, entityType, row)
}

// AAD label for whole-payload relay envelopes (PLAN-agents.md §1.3). Distinct from every row
// field label so a relay blob can never be replayed as a field value or vice versa.
const aadRelay = "companion-relay-v1"

// SealBlob encrypts an opaque payload (a relay request or response frame) under the master
// key, returning an enc$v1$ envelope. Unlike row fields, the whole body is one ciphertext.
func (c *Cipher) SealBlob(plaintext []byte) (string, error) {
	return seal(c.masterKey, plaintext, aadRelay)
}

// OpenBlob reverses SealBlob.
func (c *Cipher) OpenBlob(envelope string) ([]byte, error) {
	return open(c.masterKey, envelope, aadRelay)
}
