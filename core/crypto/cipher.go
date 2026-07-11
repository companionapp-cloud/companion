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
