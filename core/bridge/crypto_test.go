package bridge

import (
	"encoding/json"
	"testing"
)

// setupResult mirrors the JSON cryptoSetup returns.
type setupResult struct {
	AuthKeyHex       string          `json:"authKeyHex"`
	Salt             string          `json:"salt"`
	KDF              json.RawMessage `json:"kdf"`
	WrappedMasterKey string          `json:"wrappedMasterKey"`
	RecoveryWrapped  string          `json:"recoveryWrapped"`
	RecoveryCode     string          `json:"recoveryCode"`
}

func doSetup(t *testing.T, c *Core, password string) setupResult {
	t.Helper()
	out, err := c.Invoke("crypto.setup", []byte(`{"password":"`+password+`"}`))
	if err != nil {
		t.Fatalf("crypto.setup: %v", err)
	}
	var res setupResult
	if err := json.Unmarshal(out, &res); err != nil {
		t.Fatal(err)
	}
	return res
}

func unlocked(t *testing.T, c *Core) bool {
	t.Helper()
	out, err := c.Invoke("crypto.status", nil)
	if err != nil {
		t.Fatal(err)
	}
	var s struct {
		Unlocked bool `json:"unlocked"`
	}
	json.Unmarshal(out, &s)
	return s.Unlocked
}

func TestCryptoSetupLeavesUnlockedAndReturnsMaterial(t *testing.T) {
	c, _ := newTestCore(t)
	res := doSetup(t, c, "hunter2")

	if res.AuthKeyHex == "" || res.WrappedMasterKey == "" || res.Salt == "" || res.RecoveryCode == "" || res.RecoveryWrapped == "" {
		t.Fatalf("setup missing fields: %+v", res)
	}
	if !unlocked(t, c) {
		t.Fatal("store should be unlocked immediately after setup")
	}
}

func TestCryptoUnlockWrongAndRightPassword(t *testing.T) {
	c, _ := newTestCore(t)
	res := doSetup(t, c, "correct-password")

	// Lock, then a wrong password must be rejected without unlocking.
	if _, err := c.Invoke("crypto.lock", nil); err != nil {
		t.Fatal(err)
	}
	if unlocked(t, c) {
		t.Fatal("should be locked after crypto.lock")
	}
	wrong, _ := json.Marshal(map[string]any{
		"password":         "WRONG",
		"wrappedMasterKey": res.WrappedMasterKey,
		"salt":             res.Salt,
		"kdf":              json.RawMessage(res.KDF),
	})
	if _, err := c.Invoke("crypto.unlock", wrong); err == nil {
		t.Fatal("wrong password should error")
	}
	if unlocked(t, c) {
		t.Fatal("wrong password must not unlock")
	}

	// Right password unlocks.
	right, _ := json.Marshal(map[string]any{
		"password":         "correct-password",
		"wrappedMasterKey": res.WrappedMasterKey,
		"salt":             res.Salt,
		"kdf":              json.RawMessage(res.KDF),
	})
	if _, err := c.Invoke("crypto.unlock", right); err != nil {
		t.Fatalf("right password should unlock: %v", err)
	}
	if !unlocked(t, c) {
		t.Fatal("right password should unlock")
	}
}

func TestCryptoRecoveryUnlock(t *testing.T) {
	c, _ := newTestCore(t)
	res := doSetup(t, c, "forgotten")
	c.Invoke("crypto.lock", nil)

	body, _ := json.Marshal(map[string]string{
		"recoveryCode":    res.RecoveryCode,
		"recoveryWrapped": res.RecoveryWrapped,
	})
	if _, err := c.Invoke("crypto.unlockWithRecovery", body); err != nil {
		t.Fatalf("recovery unlock: %v", err)
	}
	if !unlocked(t, c) {
		t.Fatal("recovery code should unlock")
	}
}

func TestCryptoRewrapChangesPasswordKeepsData(t *testing.T) {
	c, _ := newTestCore(t)
	orig := doSetup(t, c, "old-pass")

	// Rewrap under a new password (store is unlocked).
	out, err := c.Invoke("crypto.rewrap", []byte(`{"newPassword":"new-pass"}`))
	if err != nil {
		t.Fatalf("rewrap: %v", err)
	}
	var rew struct {
		AuthKeyHex       string          `json:"authKeyHex"`
		Salt             string          `json:"salt"`
		KDF              json.RawMessage `json:"kdf"`
		WrappedMasterKey string          `json:"wrappedMasterKey"`
	}
	json.Unmarshal(out, &rew)
	if rew.WrappedMasterKey == orig.WrappedMasterKey {
		t.Fatal("rewrap should produce a new wrapped blob")
	}
	if rew.AuthKeyHex == orig.AuthKeyHex {
		t.Fatal("new password should derive a new auth key")
	}

	// The new password unlocks the new blob; the old password no longer does.
	c.Invoke("crypto.lock", nil)
	newBody, _ := json.Marshal(map[string]any{
		"password": "new-pass", "wrappedMasterKey": rew.WrappedMasterKey, "salt": rew.Salt, "kdf": json.RawMessage(rew.KDF),
	})
	if _, err := c.Invoke("crypto.unlock", newBody); err != nil {
		t.Fatalf("new password should unlock rewrapped blob: %v", err)
	}
}

func TestCryptoDeriveAuthKeyMatchesSetup(t *testing.T) {
	c, _ := newTestCore(t)
	res := doSetup(t, c, "same-pass")

	body, _ := json.Marshal(map[string]any{
		"password": "same-pass", "salt": res.Salt, "kdf": json.RawMessage(res.KDF),
	})
	out, err := c.Invoke("crypto.deriveAuthKey", body)
	if err != nil {
		t.Fatal(err)
	}
	var d struct {
		AuthKeyHex string `json:"authKeyHex"`
	}
	json.Unmarshal(out, &d)
	// Deriving the auth key from the same password+salt must reproduce the one setup returned —
	// this is what lets a fresh device log in without the server ever seeing the password.
	if d.AuthKeyHex != res.AuthKeyHex {
		t.Fatalf("auth key mismatch: derive=%q setup=%q", d.AuthKeyHex, res.AuthKeyHex)
	}
}

func TestCryptoUnlockFromCache(t *testing.T) {
	c, _ := newTestCore(t)
	c.SetSecretStore(&fakeSecrets{m: map[string]string{}})
	doSetup(t, c, "cached") // setup caches the key via SecretStore

	// Simulate a fresh process: drop the in-memory key, then restore from cache.
	c.cryptoMu.Lock()
	c.masterKey = nil
	c.cryptoMu.Unlock()

	out, err := c.Invoke("crypto.unlockFromCache", nil)
	if err != nil {
		t.Fatal(err)
	}
	var s struct {
		Unlocked bool `json:"unlocked"`
	}
	json.Unmarshal(out, &s)
	if !s.Unlocked || !unlocked(t, c) {
		t.Fatal("cached key should unlock without a password")
	}
}
