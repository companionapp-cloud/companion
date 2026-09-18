package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"companion/core/domain"
	"companion/core/sync/protocol"

	"github.com/google/uuid"
)

// ---- calendar accounts ---------------------------------------------------

// CalendarAccountsRepo is the CRUD + sync repository for CalDAV logins (PLAN-caldav.md §1). The
// row syncs so every device can write back to the provider; its content fields (including the
// credential) are encrypted on the wire by the row cipher.
type CalendarAccountsRepo struct {
	db    Driver
	clock domain.Clock
}

const accountColumns = `id, name, server_url, username, auth_kind, oauth_client_id, credential_enc, credential_ref, home_set_url, last_error, created_at, updated_at, deleted_at, version, dirty`

// CreateAccountInput carries the fields of a new account. The credential is placed by the bridge
// (in the row on an E2EE account, in the device secret store otherwise), so it is not JSON input.
type CreateAccountInput struct {
	Name          string  `json:"name"`
	ServerURL     string  `json:"serverUrl"`
	Username      string  `json:"username"`
	HomeSetURL    string  `json:"-"`
	CredentialEnc *string `json:"-"`
	CredentialRef *string `json:"-"`
	// AuthKind defaults to basic. An OAuth account also records the client id its grant belongs to.
	AuthKind      string `json:"-"`
	OAuthClientID string `json:"-"`
}

// UpdateAccountInput carries partial updates; nil fields are left unchanged.
type UpdateAccountInput struct {
	Name          *string `json:"name,omitempty"`
	HomeSetURL    *string `json:"-"`
	CredentialEnc *string `json:"-"`
	CredentialRef *string `json:"-"`
	// OAuthClientID is set together with the credential when an OAuth account is reconnected.
	OAuthClientID *string `json:"-"`
}

// Create inserts a new account (UUIDv7 id, version 0, dirty).
func (r *CalendarAccountsRepo) Create(in CreateAccountInput) (*domain.CalendarAccount, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return nil, fmt.Errorf("generate uuid: %w", err)
	}
	now := r.clock.Now().UTC()
	kind := in.AuthKind
	if kind == "" {
		kind = domain.CalendarAuthBasic
	}
	a := &domain.CalendarAccount{
		ID: id.String(), Name: in.Name, ServerURL: in.ServerURL, Username: in.Username,
		AuthKind: kind, OAuthClientID: in.OAuthClientID, CredentialEnc: in.CredentialEnc, CredentialRef: in.CredentialRef,
		HomeSetURL: in.HomeSetURL, CreatedAt: now, UpdatedAt: now, Dirty: true,
	}
	if err := a.Validate(); err != nil {
		return nil, err
	}
	if err := r.write(a); err != nil {
		return nil, err
	}
	return a, nil
}

// Get returns a single non-deleted account by id, or ErrNotFound.
func (r *CalendarAccountsRepo) Get(id string) (*domain.CalendarAccount, error) {
	a, err := r.GetAny(id)
	if err != nil {
		return nil, err
	}
	if a.DeletedAt != nil {
		return nil, ErrNotFound
	}
	return a, nil
}

// List returns all non-deleted accounts, oldest first.
func (r *CalendarAccountsRepo) List() ([]*domain.CalendarAccount, error) {
	return r.query(`SELECT ` + accountColumns + ` FROM calendar_accounts WHERE deleted_at IS NULL ORDER BY created_at ASC, id ASC;`)
}

// Update applies partial changes, bumps updated_at, marks dirty.
func (r *CalendarAccountsRepo) Update(id string, in UpdateAccountInput) (*domain.CalendarAccount, error) {
	a, err := r.Get(id)
	if err != nil {
		return nil, err
	}
	if in.Name != nil {
		a.Name = *in.Name
	}
	if in.HomeSetURL != nil {
		a.HomeSetURL = *in.HomeSetURL
	}
	if in.CredentialEnc != nil || in.CredentialRef != nil {
		a.CredentialEnc, a.CredentialRef = in.CredentialEnc, in.CredentialRef
	}
	if in.OAuthClientID != nil {
		a.OAuthClientID = *in.OAuthClientID
	}
	a.UpdatedAt = r.clock.Now().UTC()
	a.Dirty = true
	if err := a.Validate(); err != nil {
		return nil, err
	}
	if err := r.write(a); err != nil {
		return nil, err
	}
	return a, nil
}

// SetLastError records (or clears, with "") the account's most recent sync failure. It is a no-op
// when the value is unchanged, so a persistently failing account does not re-push its row on every
// refresh from every device.
func (r *CalendarAccountsRepo) SetLastError(id, msg string) error {
	a, err := r.Get(id)
	if err != nil {
		return err
	}
	if derefStr(a.LastError) == msg {
		return nil
	}
	a.LastError = nil
	if msg != "" {
		a.LastError = &msg
	}
	a.UpdatedAt = r.clock.Now().UTC()
	a.Dirty = true
	return r.write(a)
}

// Delete soft-deletes an account together with its calendars, their objects and their
// occurrences, so the removal reaches every device. Nothing is deleted from the provider.
func (r *CalendarAccountsRepo) Delete(id string) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	res, err := r.db.Exec(
		`UPDATE calendar_accounts SET deleted_at = ?, updated_at = ?, credential_enc = NULL, dirty = 1
		 WHERE id = ? AND deleted_at IS NULL;`, now, now, id)
	if err != nil {
		return fmt.Errorf("delete calendar account: %w", err)
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	const feedsOf = `(SELECT id FROM calendar_feeds WHERE account_id = ?)`
	for _, q := range []string{
		`UPDATE calendar_events SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE deleted_at IS NULL AND feed_id IN ` + feedsOf + `;`,
		`UPDATE calendar_objects SET deleted_at = ?, updated_at = ?, push_state = 'synced', dirty = 1 WHERE deleted_at IS NULL AND feed_id IN ` + feedsOf + `;`,
	} {
		if _, err := r.db.Exec(q, now, now, id); err != nil {
			return fmt.Errorf("tombstone account data: %w", err)
		}
	}
	if _, err := r.db.Exec(`DELETE FROM caldav_feed_state WHERE feed_id IN `+feedsOf+`;`, id); err != nil {
		return fmt.Errorf("clear account feed state: %w", err)
	}
	if _, err := r.db.Exec(
		`UPDATE calendar_feeds SET deleted_at = ?, updated_at = ?, dirty = 1 WHERE account_id = ? AND deleted_at IS NULL;`, now, now, id); err != nil {
		return fmt.Errorf("tombstone account feeds: %w", err)
	}
	return nil
}

func (r *CalendarAccountsRepo) write(a *domain.CalendarAccount) error {
	var deletedAt any
	if a.DeletedAt != nil {
		deletedAt = a.DeletedAt.UTC().Format(timeFormat)
	}
	_, err := r.db.Exec(
		`INSERT INTO calendar_accounts (`+accountColumns+`)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   name = excluded.name, server_url = excluded.server_url, username = excluded.username,
		   auth_kind = excluded.auth_kind, oauth_client_id = excluded.oauth_client_id, credential_enc = excluded.credential_enc,
		   credential_ref = excluded.credential_ref, home_set_url = excluded.home_set_url,
		   last_error = excluded.last_error, updated_at = excluded.updated_at,
		   deleted_at = excluded.deleted_at, version = excluded.version, dirty = excluded.dirty;`,
		a.ID, a.Name, a.ServerURL, a.Username, a.AuthKind, a.OAuthClientID, a.CredentialEnc, a.CredentialRef, a.HomeSetURL, a.LastError,
		a.CreatedAt.UTC().Format(timeFormat), a.UpdatedAt.UTC().Format(timeFormat), deletedAt, a.Version, boolToInt(a.Dirty),
	)
	if err != nil {
		return fmt.Errorf("write calendar account: %w", err)
	}
	return nil
}

func (r *CalendarAccountsRepo) query(q string, args ...any) ([]*domain.CalendarAccount, error) {
	rows, err := r.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("query calendar accounts: %w", err)
	}
	defer rows.Close()
	out := []*domain.CalendarAccount{}
	for rows.Next() {
		a, err := scanAccount(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// --- SyncableRepo[*domain.CalendarAccount] --------------------------------

func (r *CalendarAccountsRepo) EntityType() string { return protocol.EntityCalendarAccount }

func (r *CalendarAccountsRepo) Dirty() ([]*domain.CalendarAccount, error) {
	return r.query(`SELECT ` + accountColumns + ` FROM calendar_accounts WHERE dirty = 1 ORDER BY updated_at ASC, id ASC;`)
}

func (r *CalendarAccountsRepo) GetAny(id string) (*domain.CalendarAccount, error) {
	out, err := r.query(`SELECT `+accountColumns+` FROM calendar_accounts WHERE id = ?;`, id)
	if err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, ErrNotFound
	}
	return out[0], nil
}

// Apply overwrites the local account with the server-canonical one. A device-local credential
// ref is kept when the incoming row carries no credential at all (an unencrypted account, where
// each device holds its own copy of the password).
func (r *CalendarAccountsRepo) Apply(a *domain.CalendarAccount) error {
	if !a.HasCredential() {
		if local, err := r.GetAny(a.ID); err == nil && local.CredentialRef != nil {
			a.CredentialRef = local.CredentialRef
		}
	}
	a.Dirty = false
	return r.write(a)
}

func (r *CalendarAccountsRepo) MarkPushed(id string, version int64) error {
	if _, err := r.db.Exec(`UPDATE calendar_accounts SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark pushed: %w", err)
	}
	return nil
}

// MeaningfulDiff is always false: a login is not something to fork into a conflicted copy. The
// server row wins and a losing local rename is simply redone.
func (r *CalendarAccountsRepo) MeaningfulDiff(a, b *domain.CalendarAccount) bool { return false }

// ConflictedCopy is a no-op (see MeaningfulDiff).
func (r *CalendarAccountsRepo) ConflictedCopy(local *domain.CalendarAccount, suffix string) error {
	return nil
}

func (r *CalendarAccountsRepo) Decode(raw json.RawMessage) (*domain.CalendarAccount, error) {
	var a domain.CalendarAccount
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, fmt.Errorf("decode calendar account: %w", err)
	}
	if a.AuthKind == "" {
		a.AuthKind = domain.CalendarAuthBasic
	}
	return &a, nil
}

func scanAccount(rows Rows) (*domain.CalendarAccount, error) {
	var (
		a                         domain.CalendarAccount
		credEnc, credRef, lastErr sql.NullString
		deletedAt                 sql.NullString
		createdAt, updatedAt      string
		dirty                     int
	)
	if err := rows.Scan(&a.ID, &a.Name, &a.ServerURL, &a.Username, &a.AuthKind, &a.OAuthClientID, &credEnc, &credRef, &a.HomeSetURL, &lastErr,
		&createdAt, &updatedAt, &deletedAt, &a.Version, &dirty); err != nil {
		return nil, fmt.Errorf("scan calendar account: %w", err)
	}
	a.CredentialEnc, a.CredentialRef, a.LastError = nullStr(credEnc), nullStr(credRef), nullStr(lastErr)
	if err := parseRowTimes(createdAt, updatedAt, deletedAt, &a.CreatedAt, &a.UpdatedAt, &a.DeletedAt); err != nil {
		return nil, err
	}
	a.Dirty = dirty != 0
	return &a, nil
}

// ---- calendar objects ----------------------------------------------------

// CalendarObjectsRepo holds the verbatim ICS of every event resource in a CalDAV calendar
// (PLAN-caldav.md §1). It is the write-back queue as well: a row whose push_state is pending is a
// change the provider has not seen, and any native device may push it.
type CalendarObjectsRepo struct {
	db    Driver
	clock domain.Clock
}

const objectColumns = `id, feed_id, uid, href, etag, ics, recurring, push_state, push_error, created_at, updated_at, deleted_at, version, dirty`

// Get returns one non-deleted object by id, or ErrNotFound.
func (r *CalendarObjectsRepo) Get(id string) (*domain.CalendarObject, error) {
	o, err := r.GetAny(id)
	if err != nil {
		return nil, err
	}
	if o.DeletedAt != nil {
		return nil, ErrNotFound
	}
	return o, nil
}

// ListByFeed returns the live objects of one calendar, keyed by id.
func (r *CalendarObjectsRepo) ListByFeed(feedID string) (map[string]*domain.CalendarObject, error) {
	list, err := r.query(`SELECT `+objectColumns+` FROM calendar_objects WHERE feed_id = ? AND deleted_at IS NULL;`, feedID)
	if err != nil {
		return nil, err
	}
	out := make(map[string]*domain.CalendarObject, len(list))
	for _, o := range list {
		out[o.ID] = o
	}
	return out, nil
}

// CountByFeed returns how many live objects a calendar holds.
func (r *CalendarObjectsRepo) CountByFeed(feedID string) (int, error) {
	rows, err := r.db.Query(`SELECT COUNT(*) FROM calendar_objects WHERE feed_id = ? AND deleted_at IS NULL;`, feedID)
	if err != nil {
		return 0, fmt.Errorf("count calendar objects: %w", err)
	}
	defer rows.Close()
	n := 0
	if rows.Next() {
		if err := rows.Scan(&n); err != nil {
			return 0, err
		}
	}
	return n, rows.Err()
}

// Pending returns the live objects of one calendar that carry an unpushed change, oldest first so
// edits reach the provider in the order they were made.
func (r *CalendarObjectsRepo) Pending(feedID string) ([]*domain.CalendarObject, error) {
	return r.query(`SELECT `+objectColumns+` FROM calendar_objects
		WHERE feed_id = ? AND deleted_at IS NULL AND push_state != 'synced' ORDER BY updated_at ASC, id ASC;`, feedID)
}

// HasPending reports whether any calendar has changes waiting for a native device to push.
func (r *CalendarObjectsRepo) HasPending() (bool, error) {
	rows, err := r.db.Query(`SELECT 1 FROM calendar_objects WHERE deleted_at IS NULL AND push_state != 'synced' LIMIT 1;`)
	if err != nil {
		return false, fmt.Errorf("query pending objects: %w", err)
	}
	defer rows.Close()
	return rows.Next(), rows.Err()
}

// Put writes a locally-changed object: updated_at is bumped and the row is marked dirty so the
// change syncs. created_at and version are carried over from an existing row.
func (r *CalendarObjectsRepo) Put(o *domain.CalendarObject) error {
	now := r.clock.Now().UTC()
	if old, err := r.GetAny(o.ID); err == nil {
		o.CreatedAt, o.Version = old.CreatedAt, old.Version
	} else if err != ErrNotFound {
		return err
	} else {
		o.CreatedAt = now
	}
	if o.PushState == "" {
		o.PushState = domain.PushSynced
	}
	o.UpdatedAt = now
	o.Dirty = true
	return r.write(o)
}

// Tombstone soft-deletes an object (the provider confirmed the delete, or the resource vanished).
func (r *CalendarObjectsRepo) Tombstone(id string) error {
	now := r.clock.Now().UTC().Format(timeFormat)
	if _, err := r.db.Exec(
		`UPDATE calendar_objects SET deleted_at = ?, updated_at = ?, push_state = 'synced', push_error = NULL, dirty = 1
		 WHERE id = ? AND deleted_at IS NULL;`, now, now, id); err != nil {
		return fmt.Errorf("tombstone calendar object: %w", err)
	}
	return nil
}

func (r *CalendarObjectsRepo) write(o *domain.CalendarObject) error {
	var deletedAt any
	if o.DeletedAt != nil {
		deletedAt = o.DeletedAt.UTC().Format(timeFormat)
	}
	state := o.PushState
	if state == "" {
		state = domain.PushSynced
	}
	_, err := r.db.Exec(
		`INSERT INTO calendar_objects (`+objectColumns+`)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   feed_id = excluded.feed_id, uid = excluded.uid, href = excluded.href, etag = excluded.etag,
		   ics = excluded.ics, recurring = excluded.recurring, push_state = excluded.push_state,
		   push_error = excluded.push_error, updated_at = excluded.updated_at,
		   deleted_at = excluded.deleted_at, version = excluded.version, dirty = excluded.dirty;`,
		o.ID, o.FeedID, o.UID, o.Href, o.ETag, o.ICS, boolToInt(o.Recurring), string(state), o.PushError,
		o.CreatedAt.UTC().Format(timeFormat), o.UpdatedAt.UTC().Format(timeFormat), deletedAt, o.Version, boolToInt(o.Dirty),
	)
	if err != nil {
		return fmt.Errorf("write calendar object: %w", err)
	}
	return nil
}

func (r *CalendarObjectsRepo) query(q string, args ...any) ([]*domain.CalendarObject, error) {
	rows, err := r.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("query calendar objects: %w", err)
	}
	defer rows.Close()
	out := []*domain.CalendarObject{}
	for rows.Next() {
		o, err := scanObject(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// --- SyncableRepo[*domain.CalendarObject] ---------------------------------

func (r *CalendarObjectsRepo) EntityType() string { return protocol.EntityCalendarObject }

func (r *CalendarObjectsRepo) Dirty() ([]*domain.CalendarObject, error) {
	return r.query(`SELECT ` + objectColumns + ` FROM calendar_objects WHERE dirty = 1 ORDER BY updated_at ASC, id ASC;`)
}

func (r *CalendarObjectsRepo) GetAny(id string) (*domain.CalendarObject, error) {
	out, err := r.query(`SELECT `+objectColumns+` FROM calendar_objects WHERE id = ?;`, id)
	if err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, ErrNotFound
	}
	return out[0], nil
}

// Apply overwrites the local object with the server-canonical one, clearing dirty.
func (r *CalendarObjectsRepo) Apply(o *domain.CalendarObject) error {
	o.Dirty = false
	return r.write(o)
}

func (r *CalendarObjectsRepo) MarkPushed(id string, version int64) error {
	if _, err := r.db.Exec(`UPDATE calendar_objects SET dirty = 0, version = ? WHERE id = ?;`, version, id); err != nil {
		return fmt.Errorf("mark pushed: %w", err)
	}
	return nil
}

// MeaningfulDiff is always false: an event must never be forked into a "conflicted copy" — that
// would put a duplicate on the user's real calendar. When two devices disagree the synced row
// wins here, and the provider's etag check is what finally arbitrates the write (PLAN-caldav.md §0).
func (r *CalendarObjectsRepo) MeaningfulDiff(a, b *domain.CalendarObject) bool { return false }

// ConflictedCopy is a no-op (see MeaningfulDiff).
func (r *CalendarObjectsRepo) ConflictedCopy(local *domain.CalendarObject, suffix string) error {
	return nil
}

func (r *CalendarObjectsRepo) Decode(raw json.RawMessage) (*domain.CalendarObject, error) {
	var o domain.CalendarObject
	if err := json.Unmarshal(raw, &o); err != nil {
		return nil, fmt.Errorf("decode calendar object: %w", err)
	}
	return &o, nil
}

func scanObject(rows Rows) (*domain.CalendarObject, error) {
	var (
		o                    domain.CalendarObject
		pushErr, deletedAt   sql.NullString
		createdAt, updatedAt string
		state                string
		recurring, dirty     int
	)
	if err := rows.Scan(&o.ID, &o.FeedID, &o.UID, &o.Href, &o.ETag, &o.ICS, &recurring, &state, &pushErr,
		&createdAt, &updatedAt, &deletedAt, &o.Version, &dirty); err != nil {
		return nil, fmt.Errorf("scan calendar object: %w", err)
	}
	o.PushState = domain.PushState(state)
	o.PushError = nullStr(pushErr)
	o.Recurring = recurring != 0
	if err := parseRowTimes(createdAt, updatedAt, deletedAt, &o.CreatedAt, &o.UpdatedAt, &o.DeletedAt); err != nil {
		return nil, err
	}
	o.Dirty = dirty != 0
	return &o, nil
}

// parseRowTimes parses the three standard sync timestamps of a row.
func parseRowTimes(createdAt, updatedAt string, deletedAt sql.NullString, c, u *time.Time, d **time.Time) error {
	var err error
	if *c, err = time.Parse(timeFormat, createdAt); err != nil {
		return fmt.Errorf("parse created_at: %w", err)
	}
	if *u, err = time.Parse(timeFormat, updatedAt); err != nil {
		return fmt.Errorf("parse updated_at: %w", err)
	}
	if deletedAt.Valid {
		t, err := time.Parse(timeFormat, deletedAt.String)
		if err != nil {
			return fmt.Errorf("parse deleted_at: %w", err)
		}
		*d = &t
	}
	return nil
}
