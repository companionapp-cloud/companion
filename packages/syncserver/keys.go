package syncserver

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"

	"companion/core/crypto"
)

// End-to-end encryption key storage (PLAN §E2EE). The server is a blind custodian of the user's
// wrapped master key: it stores and returns the blob and its KDF parameters, but every value is
// ciphertext or public derivation metadata. It cannot read the master key, and therefore cannot
// read any note/task/calendar content. A user_keys row is created when a device enables
// encryption (PUT) and fetched by every other device to unlock (GET); its absence means the
// account is still plaintext.

// keyMaterial is the wire shape of a user's wrapped key + derivation parameters, exchanged by
// GET/PUT /v1/keys. The client derives the KEK from the password and these params, unwraps the
// master key locally, and never sends any of that back.
type keyMaterial struct {
	WrappedMasterKey string `json:"wrappedMasterKey"`
	KDFSalt          string `json:"kdfSalt"`
	KDFTime          int64  `json:"kdfTime"`
	KDFMemoryK       int64  `json:"kdfMemoryK"`
	KDFThreads       int64  `json:"kdfThreads"`
	RecoveryWrapped  string `json:"recoveryWrapped,omitempty"`
	PublicKey        string `json:"publicKey,omitempty"`
}

// handleGetKeys returns the authenticated user's key material, or 404 when the account has no
// encryption set up yet (the signal a client uses to stay in plaintext mode).
func (s *Server) handleGetKeys(w http.ResponseWriter, r *http.Request) {
	uid := userID(r)
	var km keyMaterial
	var recovery, pubKey sql.NullString
	err := s.queryRow(
		`SELECT wrapped_master_key, kdf_salt, kdf_time, kdf_memory_k, kdf_threads, recovery_wrapped, public_key
		 FROM user_keys WHERE user_id = ?;`, uid).
		Scan(&km.WrappedMasterKey, &km.KDFSalt, &km.KDFTime, &km.KDFMemoryK, &km.KDFThreads, &recovery, &pubKey)
	if err == sql.ErrNoRows {
		writeErr(w, http.StatusNotFound, "no encryption key for this account")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "key lookup failed")
		return
	}
	km.RecoveryWrapped = recovery.String
	km.PublicKey = pubKey.String
	writeJSON(w, http.StatusOK, km)
}

// handlePutKeys stores (or replaces) the user's wrapped key material. Replacement is how a
// password change rewraps the same master key under a new KEK — the content never re-encrypts,
// only the wrapping does. The server validates only shape, never the cryptographic contents it
// cannot read. (A password change carries its rewrapped material atomically via
// handleUpdatePassword; this endpoint remains for the initial enable-encryption upload.)
func (s *Server) handlePutKeys(w http.ResponseWriter, r *http.Request) {
	uid := userID(r)
	var km keyMaterial
	if err := decode(r, &km); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	if !km.valid() {
		writeErr(w, http.StatusBadRequest, "wrapped key, salt, and positive KDF params are required")
		return
	}
	if err := s.upsertUserKeys(execer{s: s}, uid, km); err != nil {
		writeErr(w, http.StatusInternalServerError, "key store failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// valid reports whether the key material has the required non-empty blob, salt, and positive KDF
// params. The server checks shape only — it can't inspect the ciphertext.
func (km keyMaterial) valid() bool {
	return strings.TrimSpace(km.WrappedMasterKey) != "" && strings.TrimSpace(km.KDFSalt) != "" &&
		km.KDFTime > 0 && km.KDFMemoryK > 0 && km.KDFThreads > 0
}

// sqlExecer is the subset of *sql.DB / *sql.Tx that upsertUserKeys needs, so it can write either
// standalone (PUT /v1/keys) or inside the password-change transaction. *sql.Tx satisfies it
// directly; the standalone path uses execer over the raw *sql.DB. Both receive an already-rebound
// query, so neither must (double-)rebind.
type sqlExecer interface {
	Exec(query string, args ...any) (sql.Result, error)
}

// execer runs a pre-rebound query straight against the raw DB (no second rebind, unlike s.exec).
type execer struct{ s *Server }

func (e execer) Exec(query string, args ...any) (sql.Result, error) { return e.s.db.Exec(query, args...) }

// upsertUserKeys writes the wrapped key material for a user via the given executor, having already
// applied dialect rebind. Callers needing atomicity with another change (the password swap) pass
// their *sql.Tx directly; the standalone endpoint passes execer over the raw DB.
func (s *Server) upsertUserKeys(x sqlExecer, uid string, km keyMaterial) error {
	now := s.clock.Now().UTC().Format(timeFormat)
	q := s.rebind(
		`INSERT INTO user_keys (user_id, wrapped_master_key, kdf_salt, kdf_time, kdf_memory_k, kdf_threads, recovery_wrapped, public_key, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (user_id) DO UPDATE SET
		   wrapped_master_key = excluded.wrapped_master_key, kdf_salt = excluded.kdf_salt,
		   kdf_time = excluded.kdf_time, kdf_memory_k = excluded.kdf_memory_k,
		   kdf_threads = excluded.kdf_threads, recovery_wrapped = excluded.recovery_wrapped,
		   public_key = excluded.public_key, updated_at = excluded.updated_at;`)
	_, err := x.Exec(q, uid, km.WrappedMasterKey, km.KDFSalt, km.KDFTime, km.KDFMemoryK, km.KDFThreads,
		nullIfEmpty(km.RecoveryWrapped), nullIfEmpty(km.PublicKey), now)
	return err
}

// userIsEncrypted reports whether the account has key material (i.e. E2EE is enabled).
func (s *Server) userIsEncrypted(uid string) (bool, error) {
	var one int
	err := s.queryRow(`SELECT 1 FROM user_keys WHERE user_id = ?;`, uid).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

// nullIfEmpty stores an empty optional string as SQL NULL rather than "".
func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// isEncryptedField reports whether a stored/pushed field value is an end-to-end-encrypted
// envelope (a JSON string carrying the enc$v1$ marker) rather than plaintext content the server
// can inspect. Used to skip server-side validation the encryption makes impossible.
func isEncryptedField(raw json.RawMessage) bool {
	if len(raw) == 0 || raw[0] != '"' {
		return false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return false
	}
	return crypto.IsEnvelope(s)
}
