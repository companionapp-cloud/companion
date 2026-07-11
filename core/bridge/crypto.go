package bridge

import (
	"encoding/base64"
	"encoding/json"
	"errors"

	"companion/core/crypto"
)

// End-to-end encryption control surface (PLAN §E2EE). These bridge methods own the key material
// so it lives in the Go core (where the sync engine encrypts/decrypts), never in JS/Swift/Kotlin.
// The shell drives the flow — fetch/PUT the wrapped blob against /v1/keys, prompt for the
// password — but the actual key derivation, wrapping, and the in-memory master key stay here.
//
// masterKeyCacheRef is where the unlocked master key is cached in the platform keychain
// (SecretStore) so a returning user isn't re-prompted every launch. Web, which has no SecretStore,
// simply re-unlocks from the password each session.
const masterKeyCacheRef = "companion.e2ee.masterKey"

// kekParams is the wire form of a wrapped key's derivation inputs: the salt (base64) plus the
// Argon2id cost params. The shell stores these next to the wrapped blob on the server and hands
// them back on unlock so any device reproduces the exact KEK.
type kekParams struct {
	Salt string           `json:"salt"` // base64
	KDF  crypto.KDFParams `json:"kdf"`
}

func (p kekParams) saltBytes() ([]byte, error) { return base64.StdEncoding.DecodeString(p.Salt) }

// cryptoSetup provisions encryption for an account for the first time: it generates the salt,
// master key, and a one-time recovery code, then returns everything the shell must persist — the
// server-facing auth key (which replaces the password credential), the wrapped master key, the
// KDF params, the recovery-wrapped copy, and the recovery code to show the user once. The master
// key is left unlocked in memory so the very next sync encrypts.
func (c *Core) cryptoSetup(payload []byte) ([]byte, error) {
	var args struct {
		Password string `json:"password"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	if args.Password == "" {
		return nil, errors.New("password is required")
	}
	salt, err := crypto.NewSalt()
	if err != nil {
		return nil, err
	}
	params := crypto.DefaultKDFParams()
	dk, err := crypto.DeriveKeys(args.Password, salt, params)
	if err != nil {
		return nil, err
	}
	master, err := crypto.NewMasterKey()
	if err != nil {
		return nil, err
	}
	wrapped, err := crypto.WrapMasterKey(dk.KEK, master)
	if err != nil {
		return nil, err
	}
	recoveryCode, err := crypto.NewRecoveryCode()
	if err != nil {
		return nil, err
	}
	recoveryKey, err := crypto.RecoveryKey(recoveryCode)
	if err != nil {
		return nil, err
	}
	recoveryWrapped, err := crypto.WrapMasterKeyRecovery(recoveryKey, master)
	if err != nil {
		return nil, err
	}
	c.setMasterKey(master)
	return json.Marshal(map[string]any{
		"authKeyHex":       crypto.EncodeHex(dk.AuthKey),
		"salt":             base64.StdEncoding.EncodeToString(salt),
		"kdf":              params,
		"wrappedMasterKey": wrapped,
		"recoveryWrapped":  recoveryWrapped,
		"recoveryCode":     recoveryCode,
	})
}

// cryptoDeriveAuthKey turns a password + the account's stored salt/params into the server-facing
// auth key, so login can authenticate without the server ever seeing the password. The shell
// fetches the salt/params first (a pre-login lookup), then sends this hex as the credential.
func (c *Core) cryptoDeriveAuthKey(payload []byte) ([]byte, error) {
	var args struct {
		Password string `json:"password"`
		kekParams
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	salt, err := args.saltBytes()
	if err != nil {
		return nil, errors.New("invalid salt")
	}
	hexKey, err := crypto.AuthKeyHex(args.Password, salt, args.KDF)
	if err != nil {
		return nil, err
	}
	return json.Marshal(map[string]string{"authKeyHex": hexKey})
}

// cryptoUnlock derives the KEK from the password and unwraps the master key, holding it in memory
// (and caching it) so sync can encrypt/decrypt. A wrong password fails authentication and returns
// an error — this is the only place a password is checked against the key, and it happens entirely
// on-device.
func (c *Core) cryptoUnlock(payload []byte) ([]byte, error) {
	var args struct {
		Password         string `json:"password"`
		WrappedMasterKey string `json:"wrappedMasterKey"`
		kekParams
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	salt, err := args.saltBytes()
	if err != nil {
		return nil, errors.New("invalid salt")
	}
	dk, err := crypto.DeriveKeys(args.Password, salt, args.KDF)
	if err != nil {
		return nil, err
	}
	master, err := crypto.UnwrapMasterKey(dk.KEK, args.WrappedMasterKey)
	if err != nil {
		if errors.Is(err, crypto.ErrDecrypt) {
			return nil, errors.New("incorrect password")
		}
		return nil, err
	}
	c.setMasterKey(master)
	return json.Marshal(map[string]bool{"unlocked": true})
}

// cryptoUnlockWithRecovery unlocks using the recovery code instead of the password — the escape
// hatch for a forgotten password. The shell typically follows this by prompting for a new password
// and calling cryptoRewrap.
func (c *Core) cryptoUnlockWithRecovery(payload []byte) ([]byte, error) {
	var args struct {
		RecoveryCode    string `json:"recoveryCode"`
		RecoveryWrapped string `json:"recoveryWrapped"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	recoveryKey, err := crypto.RecoveryKey(args.RecoveryCode)
	if err != nil {
		return nil, err
	}
	master, err := crypto.UnwrapMasterKeyRecovery(recoveryKey, args.RecoveryWrapped)
	if err != nil {
		if errors.Is(err, crypto.ErrDecrypt) {
			return nil, errors.New("incorrect recovery code")
		}
		return nil, err
	}
	c.setMasterKey(master)
	return json.Marshal(map[string]bool{"unlocked": true})
}

// cryptoRewrap re-wraps the already-unlocked master key under a new password, for a password
// change. The content never re-encrypts — only the small wrapped-key blob changes — so a password
// change is instant regardless of how much data the user has. Returns the new auth key + wrapped
// blob for the shell to store; the recovery-wrapped copy is untouched.
func (c *Core) cryptoRewrap(payload []byte) ([]byte, error) {
	var args struct {
		NewPassword string `json:"newPassword"`
	}
	if err := unmarshal(payload, &args); err != nil {
		return nil, err
	}
	master := c.getMasterKey()
	if master == nil {
		return nil, errors.New("store is locked; unlock before changing the password")
	}
	salt, err := crypto.NewSalt()
	if err != nil {
		return nil, err
	}
	params := crypto.DefaultKDFParams()
	dk, err := crypto.DeriveKeys(args.NewPassword, salt, params)
	if err != nil {
		return nil, err
	}
	wrapped, err := crypto.WrapMasterKey(dk.KEK, master)
	if err != nil {
		return nil, err
	}
	// Refresh the cached key material implicitly stays valid (same master key); no re-cache needed.
	return json.Marshal(map[string]any{
		"authKeyHex":       crypto.EncodeHex(dk.AuthKey),
		"salt":             base64.StdEncoding.EncodeToString(salt),
		"kdf":              params,
		"wrappedMasterKey": wrapped,
	})
}

// cryptoUnlockFromCache restores the master key from the platform keychain without a password, so
// a returning user on a native device syncs immediately. Returns {unlocked:false} when no cached
// key exists (web, or a device that was locked).
func (c *Core) cryptoUnlockFromCache() ([]byte, error) {
	if c.secrets == nil {
		return json.Marshal(map[string]bool{"unlocked": false})
	}
	hexKey, err := c.secrets.GetSecret(masterKeyCacheRef)
	if err != nil || hexKey == "" {
		return json.Marshal(map[string]bool{"unlocked": false})
	}
	master, err := decodeHexKey(hexKey)
	if err != nil {
		return json.Marshal(map[string]bool{"unlocked": false})
	}
	c.cryptoMu.Lock()
	c.masterKey = master
	c.cryptoMu.Unlock()
	return json.Marshal(map[string]bool{"unlocked": true})
}

// cryptoLock drops the in-memory master key and clears the cache, so subsequent syncs stay in
// plaintext mode and the key must be re-derived from the password to resume.
func (c *Core) cryptoLock() ([]byte, error) {
	c.cryptoMu.Lock()
	c.masterKey = nil
	c.cryptoMu.Unlock()
	if c.secrets != nil {
		_ = c.secrets.DeleteSecret(masterKeyCacheRef)
	}
	return json.Marshal(map[string]bool{"ok": true})
}

// cryptoStatus reports whether the store is currently unlocked.
func (c *Core) cryptoStatus() ([]byte, error) {
	return json.Marshal(map[string]bool{"unlocked": c.getMasterKey() != nil})
}

// cryptoReencryptAll flags every content row dirty so the next sync re-pushes it encrypted — the
// local half of migrating an existing plaintext account to encryption (the shell first swaps the
// login credential and uploads the wrapped key). Requires the store to be unlocked, or the re-push
// would go out in plaintext.
func (c *Core) cryptoReencryptAll() ([]byte, error) {
	if c.getMasterKey() == nil {
		return nil, errors.New("unlock before enabling encryption")
	}
	n, err := c.store.MarkAllForReencryption()
	if err != nil {
		return nil, err
	}
	return json.Marshal(map[string]int{"marked": n})
}

// setMasterKey holds the key in memory and best-effort caches it in the platform keychain.
func (c *Core) setMasterKey(master []byte) {
	c.cryptoMu.Lock()
	c.masterKey = master
	c.cryptoMu.Unlock()
	if c.secrets != nil {
		_ = c.secrets.SetSecret(masterKeyCacheRef, crypto.EncodeHex(master))
	}
}

// getMasterKey returns the unlocked key (nil when locked). The slice is the live key; callers must
// not mutate it.
func (c *Core) getMasterKey() []byte {
	c.cryptoMu.Lock()
	defer c.cryptoMu.Unlock()
	return c.masterKey
}

// decodeHexKey parses a hex-encoded 32-byte key.
func decodeHexKey(s string) ([]byte, error) {
	if len(s) != crypto.KeyLen*2 {
		return nil, errors.New("bad key length")
	}
	out := make([]byte, crypto.KeyLen)
	for i := 0; i < crypto.KeyLen; i++ {
		hi, err := hexVal(s[i*2])
		if err != nil {
			return nil, err
		}
		lo, err := hexVal(s[i*2+1])
		if err != nil {
			return nil, err
		}
		out[i] = hi<<4 | lo
	}
	return out, nil
}

func hexVal(b byte) (byte, error) {
	switch {
	case b >= '0' && b <= '9':
		return b - '0', nil
	case b >= 'a' && b <= 'f':
		return b - 'a' + 10, nil
	case b >= 'A' && b <= 'F':
		return b - 'A' + 10, nil
	}
	return 0, errors.New("invalid hex")
}
